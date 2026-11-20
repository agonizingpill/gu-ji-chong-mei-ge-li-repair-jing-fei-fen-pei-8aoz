import time,logging,json
from pathlib import Path
from sqlalchemy import select
from .database import Session
from .models import RiskAssessment,Observation,CorrectionBatch,CorrectionItem
from .risk_service import queue
from .algorithm import classify
from . import correction_service as correction
logging.basicConfig(level=logging.INFO)
Path('/artifacts').mkdir(exist_ok=True)
while True:
    Path('/tmp/worker-heartbeat').touch()
    try:
        # 优先取风险队列，其次取含水更正队列；两条队列互不阻塞。
        item=queue.blpop('folio:risk',timeout=1) or queue.blpop(correction.QUEUE_NAME,timeout=1)
        if not item:continue
        name,payload=item
        with Session() as db:
            if name=='folio:risk':
                row=db.get(RiskAssessment,int(payload))
                if not row or row.status!='queued':continue
                row.status='running';db.commit()
                try:
                    obs=db.get(Observation,row.observation_id)
                    row.predicted,row.metrics=classify(obs.humidity,obs.holes,obs.mold);row.status='done';row.error=''
                    Path(f'/artifacts/risk-{row.id}.json').write_text(json.dumps(row.metrics,ensure_ascii=False))
                except Exception as exc:row.status='failed';row.error=str(exc)[:200]
                db.commit()
            else:
                row=db.get(CorrectionItem,int(payload))
                if not row or row.status!='queued':continue
                batch=db.get(CorrectionBatch,row.batch_id)
                if not batch or batch.status!=correction.BATCH_OPEN:continue
                row.status='running';db.commit()
                try:
                    correction.run_item(db,row)
                    Path(f'/artifacts/correction-{row.id}.json').write_text(json.dumps(row.metrics,ensure_ascii=False))
                except Exception as exc:row.status='failed';row.error=str(exc)[:200]
                db.commit()
    except Exception:logging.exception('worker iteration');time.sleep(1)
