import os
import redis
from sqlalchemy import select
from .models import (
    Accession,Observation,Isolation,RiskAssessment,
    CorrectionBatch,CorrectionItem,
)
from .common import get,reject,finish,audit
from .algorithm import classify

queue=redis.Redis.from_url(os.getenv('REDIS_URL','redis://redis:6379/0'),decode_responses=True)
QUEUE_NAME='folio:correction'
# 册项状态机：queued → running → done / failed；整批退回后统一 returned
ITEM_TERMINAL={'done','returned'}
BATCH_OPEN='open'
BATCH_RETURNED='returned'
BATCH_SWITCHED='switched'


def open_batch(db):
    """当前仍受理的更正批（未退回、未切换）。同一时刻只允许一批。"""
    return db.scalar(select(CorrectionBatch).where(CorrectionBatch.status==BATCH_OPEN))


def mark_returned(db,accession_id,reason):
    """批内卷册发生并发复测或出柜时，整批退回复核；业务动作本身照常办理并留档。"""
    batch=db.scalar(
        select(CorrectionBatch).where(CorrectionBatch.status==BATCH_OPEN)
        .join(CorrectionItem,CorrectionItem.batch_id==CorrectionBatch.id)
        .where(CorrectionItem.accession_id==accession_id)
    )
    if not batch:return None
    batch.status=BATCH_RETURNED;batch.return_reason=reason[:300]
    # 整批退回：所有册项一并标记退回；已算出的预测与指标仍保留在记录中可查。
    for item in db.scalars(select(CorrectionItem).where(CorrectionItem.batch_id==batch.id)):
        item.status='returned';item.error=(item.error or reason)[:200]
    return batch


def create_batch(db,data,user):
    from .catalog_service import latest_observation
    reject(open_batch(db) is not None,'已有在办含水更正批，须先切换或退回复核后再建新批')
    ids=[v.accession_id for v in data.items]
    reject(len(ids)!=len(set(ids)),'同一卷册在批内重复出现，请每册只填一条更正值')
    batch=CorrectionBatch(reason=data.reason,total=len(data.items));db.add(batch);db.flush()
    queued=[]
    for line in data.items:
        folio=get(db,Accession,line.accession_id,True)
        isolation=db.scalar(select(Isolation).where(Isolation.accession_id==folio.id,Isolation.active==True))
        reject(not isolation,f'《{folio.title}》不在隔离柜，仅受理在柜古籍的含水更正')
        obs=latest_observation(db,folio.id)
        reject(not obs,f'《{folio.title}》尚无测量记录，无法更正')
        item=CorrectionItem(
            batch_id=batch.id,accession_id=folio.id,
            snapshot_observation_id=obs.id,original_humidity=obs.humidity,
            corrected_humidity=line.corrected_humidity,
        )
        db.add(item);db.flush();queued.append(item.id)
    db.flush()
    for item_id in queued:queue.rpush(QUEUE_NAME,item_id)
    return finish(db,user,'建立含水更正批',batch)


def retry_item(db,item_id,user):
    item=get(db,CorrectionItem,item_id,True)
    batch=get(db,CorrectionBatch,item.batch_id,True)
    reject(batch.status!=BATCH_OPEN,'该更正批已退回或已切换，不能再重试')
    reject(item.status!='failed','仅失败册项可重试')
    reject(item.retry_count>=1,'该册更正已重试一次，仍失败须整批复核后重建')
    item.retry_count+=1;item.status='queued';item.error='';db.flush()
    queue.rpush(QUEUE_NAME,item.id)
    return finish(db,user,'重试含水更正',item)


def run_item(db,item):
    """worker 调用：用现有决策树对更正值重算，切换前只留册项结果，不动原测量与原分级。"""
    obs=db.get(Observation,item.snapshot_observation_id)
    predicted,metrics=classify(item.corrected_humidity,obs.holes,obs.mold)
    item.predicted=predicted;item.metrics=metrics;item.status='done';item.error=''


def switch_batch(db,batch_id,user):
    from .catalog_service import latest_observation
    batch=get(db,CorrectionBatch,batch_id,True)
    reject(batch.status==BATCH_SWITCHED,'该更正批已一次性切换，不能重复切换')
    reject(batch.status==BATCH_RETURNED,'更正批已退回复核，须重建批次后再切换')
    items=list(db.scalars(select(CorrectionItem).where(CorrectionItem.batch_id==batch.id)))
    pending=[v for v in items if v.status not in ITEM_TERMINAL or (v.status=='done' and not v.predicted)]
    reject(pending,'全批尚未算齐，待所有册项完成分级后再切换')
    # 切换前最后核对：期间若有并发复测或出柜，整批退回，业务单据照常留档
    drifted=[]
    for item in items:
        latest=latest_observation(db,item.accession_id)
        isolation=db.scalar(select(Isolation).where(Isolation.accession_id==item.accession_id,Isolation.active==True))
        if not latest or latest.id!=item.snapshot_observation_id:
            drifted.append((item,'期间发生并发复测，原测量已更新'))
        elif not isolation:
            drifted.append((item,'期间卷册已出柜'))
    if drifted:
        reasons={item.id:reason for item,reason in drifted}
        batch.status=BATCH_RETURNED
        batch.return_reason='；'.join(sorted(set(reasons.values())))[:300]
        for item in items:
            item.status='returned'
            item.error=reasons.get(item.id,batch.return_reason)[:200]
        audit(db,user,'更正批切换被拒并退回',f'batch={batch.id} {batch.return_reason}');db.commit()
        reject(True,'切换前复核发现并发复测或出柜，整批已退回复核')
    # 一次性切换：以更正值写入新观测（原测量保留），并生成待复核的新分级
    for item in items:
        source=db.get(Observation,item.snapshot_observation_id)
        new_obs=Observation(
            accession_id=item.accession_id,humidity=item.corrected_humidity,
            holes=source.holes,mold=source.mold,
            note=f'含水更正批#{batch.id} 主管更正值；原观测#{source.id} 含水{source.humidity}% 留档',
        )
        db.add(new_obs);db.flush()
        assessment=RiskAssessment(
            accession_id=item.accession_id,observation_id=new_obs.id,
            status='done',predicted=item.predicted,metrics=item.metrics,
        )
        db.add(assessment);db.flush()
        item.corrected_observation_id=new_obs.id
        item.risk_assessment_id=assessment.id
    batch.status=BATCH_SWITCHED
    from .models import now
    batch.switched_at=now()
    return finish(db,user,'含水更正批一次性切换',batch)
