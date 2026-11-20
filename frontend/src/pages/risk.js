import {store,reload} from '../stores/workspace.js';import {folioOptions,folioName} from '../components/folio-index.js';import {ledger,field,input,select,badge} from '../components/ledger.js';import {esc,date} from '../utils/format.js';import {bindForm,num,request} from '../utils/forms.js';import {levels,correctionBatchStates,correctionItemStates} from '../constants/enums.js';
const itemStatusText=v=>correctionItemStates[v.status]||v.status;
const inCabinetOptions=d=>{
 const active=new Set(d.isolations.filter(v=>v.active).map(v=>v.accession_id));
 return d.accessions.filter(a=>active.has(a.id)).map(a=>`<option value="${a.id}">${esc(a.code)} · ${esc(a.title)}</option>`).join('');
};
function lineHtml(d){return `<div class="correction-line">${select('accession_id',inCabinetOptions(d))}${input('corrected_humidity','number','',`min="0" max="100" step="0.1" placeholder="更正含水 %"`)}</div>`;}
function batchPanel(d,isSuper){
 const batch=d.correction_batches.at(-1);
 if(!batch)return `<h3>含水批量更正</h3><p class="hint">暂无更正批。在柜卷册含水录错时，由主管按每册最新测量填更正值建批，用现有决策树整批改算。</p>`;
 const items=d.correction_items.filter(v=>v.batch_id===batch.id);
 const done=items.filter(v=>v.status==='done').length;
 const failed=items.filter(v=>v.status==='failed').length;
 const returned=items.filter(v=>v.status==='returned').length;
 const allDone=batch.status==='open'&&items.length>0&&items.every(v=>v.status==='done');
 return `<h3>含水批量更正 · 批次 #${batch.id} ${badge(correctionBatchStates[batch.status]||batch.status,batch.status==='returned'?'high':batch.status==='switched'?'low':'medium')}</h3>
 <p class="hint">建批原因：${esc(batch.reason)}　进度 ${done}/${batch.total} 已算齐${failed?`　失败 ${failed}`:''}${returned?`　退回 ${returned}`:''}${batch.switched_at?`　切换时间 ${date(batch.switched_at)}`:''}</p>
 ${batch.status==='returned'?`<p class="notice error">整批退回复核，原因：${esc(batch.return_reason)}。原测量与已签出柜单照常留档；核对后请重建更正批。</p>`:''}
 ${batch.status==='open'&&isSuper?`<form id="switch-batch" class="inline-form"><input type="hidden" name="id" value="${batch.id}"><button ${allDone?'':'disabled'}>全批算齐后一次性切换</button><span class="hint">${allDone?'切换后以更正值生成新观测与待复核分级，原测量留档，须重新主管复核才可出柜':'尚有册项未算齐，切换按钮锁定'}</span></form>`:''}
 ${ledger(['卷册','原含水 → 更正','快照观测','更正预测','册项进度','错误 / 退回原因','操作'],items.map(v=>[
  folioName(d,v.accession_id),
  `${v.original_humidity}% → <strong>${v.corrected_humidity}%</strong>`,
  '#'+v.snapshot_observation_id,
  badge(levels[v.predicted]||'待运算',v.predicted||''),
  esc(itemStatusText(v))+(v.retry_count?`（已重试 ${v.retry_count} 次）`:''),
  esc(v.error||'—'),
  v.status==='failed'&&v.retry_count<1&&batch.status==='open'&&isSuper?`<form id="retry-${v.id}"><button class="muted">重试一次</button></form>`:'—',
 ]))}`;
}
export function render(){
 const d=store.data;const latest=d.risk_assessments.at(-1);const isSuper=store.session.role==='supervisor';
 return `<h2>虫霉风险分级</h2>
 <p class="intro">按当前病害观测预测隔离等级，再由主管复核。追加复测后，旧复核不再可用于开工与交接。含水录错可走下方批量更正：全批算齐才一次性切换，切换前业务照旧；并发病害复测或出柜将整批退回，原测量与出柜单留档。</p>
 <div class="forms-two"><form id="assess"><h3>提交当前病害分级</h3>${field('在柜卷册',select('accession_id',folioOptions(d)))}<button>送交分级</button><p class="hint">提交后点“刷新卷宗”查看结果。</p></form>
 <form id="review"><h3>主管复核签</h3>${field('已完成分级',select('id',d.risk_assessments.filter(v=>v.status==='done').map(v=>`<option value="${v.id}">#${v.id} ${folioName(d,v.accession_id)} / ${levels[v.predicted]}</option>`).join('')))}${field('复核等级',select('level',Object.entries(levels).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')))}${field('现场依据',input('note','text','纸张干燥，霉斑已清除'))}<button>签署复核</button></form></div>
 ${isSuper?`<section class="correction-block"><h3>建立含水更正批（主管）</h3><form id="correction-batch">${field('更正事由',input('reason','text','本批在柜古籍含水率录入错误，按各册最新测量填更正值'))}<div id="correction-lines">${lineHtml(d)}</div><button type="button" id="add-line" class="muted">再加一册</button><button>建立更正批并送交改算</button><p class="hint">每册取建批时的最新观测做快照；重试每册仅生效一次；同一时间只允许一个在办更正批。</p></form></section>`:''}
 <section class="correction-block">${batchPanel(d,isSuper)}</section>
 ${d.correction_batches.length>1?`<h3>历史更正批</h3>${ledger(['批次','事由','状态','册数','退回原因','切换时间'],d.correction_batches.slice(0,-1).reverse().map(b=>['#'+b.id,esc(b.reason),esc(correctionBatchStates[b.status]||b.status),b.total,esc(b.return_reason||'—'),b.switched_at?date(b.switched_at):'—']))}`:''}
 <h3>风险记录与观测版本</h3>${ledger(['卷册','观测编号','预测 / 复核','进度','主管意见'],d.risk_assessments.slice().reverse().map(a=>[folioName(d,a.accession_id),'#'+a.observation_id,badge(levels[a.predicted]||'待运算',a.predicted||'')+' / '+(levels[a.approved]||'—'),esc(({queued:'排队',running:'分级中',done:'待复核',reviewed:'已复核',failed:'失败'})[a.status]),esc(a.review_note||a.error)]))}
 <section class="model-sheet"><div><span class="eyebrow">分层留出验证</span><h3>病害阈值的可复现检查</h3><p>训练样本由专家规则合成；留出结果仅用于内部验证，实际业务以主管现场复核为准。</p><p>${esc(latest?.metrics?.data_source||'等待分级结果')}</p></div><div><b>Macro F1 ${latest?.metrics?.macro_f1?.toFixed(4)||'—'}</b><p>训练 ${latest?.metrics?.train_count||0} / 留出 ${latest?.metrics?.test_count||0} / seed 31</p>${latest?.metrics?.confusion_matrix?ledger(['实际\\预测','低','中','高'],latest.metrics.confusion_matrix.map((r,i)=>[levels[latest.metrics.labels[i]],...r])):''}</div></section>`;
}
export function bind(r){
 bindForm('assess',d=>request('/risks',num(d,'accession_id')),r);
 bindForm('review',d=>{const id=d.id;delete d.id;return request('/risks/'+id+'/review',d);},r);
 const add=document.getElementById('add-line');
 if(add)add.onclick=()=>document.getElementById('correction-lines').insertAdjacentHTML('beforeend',lineHtml(store.data));
 const cb=document.getElementById('correction-batch');
 if(cb)cb.onsubmit=async event=>{
  event.preventDefault();
  const button=cb.querySelector('button:not(.muted)');button.disabled=true;
  document.getElementById('notice').textContent='正在建立更正批…';
  try{
   const form=new FormData(cb);const reason=form.get('reason');
   const ids=form.getAll('accession_id');const hums=form.getAll('corrected_humidity');
   const items=ids.map((accession_id,i)=>({accession_id:Number(accession_id),corrected_humidity:Number(hums[i])}));
   await request('/correction-batches',{reason,items});
   await reload();r('更正批已送交改算');
  }catch(error){document.getElementById('notice').textContent=error.message;document.getElementById('notice').className='notice error';}
  finally{button.disabled=false;}
 };
 const sw=document.getElementById('switch-batch');
 if(sw)bindForm('switch-batch',d=>request('/correction-batches/'+d.id+'/switch',{}),r);
 store.data.correction_items?.filter(v=>v.status==='failed'&&v.retry_count<1).forEach(v=>{
  bindForm('retry-'+v.id,()=>request('/correction-items/'+v.id+'/retry',{}),r);
 });
}
