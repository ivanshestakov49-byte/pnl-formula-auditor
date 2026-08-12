const $ = (s) => document.querySelector(s);
const state = { spreadsheetId: "", spreadsheetTitle: "", requestedGid: "", sheetIds: {}, currentGid: "", issues: [], rows: [], filter: "all", history: [], historySummary: {}, historyLoaded: false };
const months = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
function fillMonths(){const selected=$("#month").value||"7";$("#month").innerHTML="";months.forEach((name,i)=>$("#month").add(new Option(name,String(i+1),false,String(i+1)===selected)));}
fillMonths();


function spreadsheetId(url) {
  return url.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] || (/^[\w-]{20,}$/.test(url.trim()) ? url.trim() : "");
}
function sheetGid(url) { return new URL(url, location.href).searchParams.get("gid") || String(url).match(/[#&?]gid=(\d+)/)?.[1] || ""; }
function colName(index) { let s = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
function norm(v) { return String(v ?? "").trim().toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " "); }
function articleCell(v) { const m=String(v??"").replace(/\u00a0/g," ").trim().match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)(.+)$/); return m&&/[A-Za-zА-Яа-яЁё]/.test(m[2])?{code:m[1],title:m[2].trim()}:null; }
function api(path) { return fetch(`/api/sheets/${state.spreadsheetId}${path}`).then(async r => { const data=await r.json(); if (!r.ok) throw new Error(data.error?.message || "Google Sheets API error"); return data; }); }

async function loadSheets() {
  const meta = await api("?fields=properties.title,sheets.properties");
  const select = $("#sheet"); select.innerHTML = '<option value="">Определить автоматически</option>';
  state.spreadsheetTitle=meta.properties?.title||"";
  state.sheetIds={}; meta.sheets.forEach(s => { state.sheetIds[s.properties.title]=String(s.properties.sheetId); select.add(new Option(s.properties.title, s.properties.title)); });
  const requested = meta.sheets.find(s => String(s.properties.sheetId) === state.requestedGid)?.properties.title;
  if (requested) select.value = requested;
  return meta.sheets.map(s => s.properties.title);
}
function chooseSheet(titles) {
  if ($("#sheet").value) return $("#sheet").value;
  return titles.find(x => /2026|действующ/i.test(x)) || titles[0];
}
function findMonthColumns(values, month, year, sheetTitle="") {
  const stems = ["январ","феврал","март","апрел","ма[йя]","июн","июл","август","сентябр","октябр","ноябр","декабр"];
  const word = new RegExp(`(^|[^а-я])${stems[month-1]}[а-я]*(?=$|[^а-я])`,"i"), numeric = new RegExp(`(^|\\D)${String(month).padStart(2,"0")}[./-]${year}(?=$|\\D)`);
  const limit = Math.min(values.length, 50), yearKnown=String(sheetTitle).includes(String(year))||values.slice(0,limit).some(row=>row.some(v=>norm(v).includes(String(year))));
  const direct=[];
  for(let r=0;r<limit;r++) for(let c=0;c<(values[r]?.length||0);c++) { const s=norm(values[r][c]); if(!word.test(s)&&!numeric.test(s))continue; if(/^план(?:$|[\s,(:/.-])/.test(s)) direct.push({r,c,type:"plan"}); if(/^факт(?:$|[\s,(:/.-])/.test(s)) direct.push({r,c,type:"fact"}); }
  const directPairs=[];
  for(const p of direct.filter(x=>x.type==="plan")) { const facts=direct.filter(x=>x.type==="fact"&&x.r===p.r&&x.c>p.c).sort((a,b)=>a.c-b.c); if(facts[0])directPairs.push({plan:p.c,fact:facts[0].c}); }
  const uniqueDirect=[...new Map(directPairs.map(x=>[`${x.plan}:${x.fact}`,x])).values()];
  if(yearKnown&&uniqueDirect.length===1)return [{key:"plan",label:"План",col:uniqueDirect[0].plan},{key:"fact",label:"Факт",col:uniqueDirect[0].fact}];
  const anchors=[];
  for (let r=0;r<limit;r++) for(let c=0;c<(values[r]?.length||0);c++) { const s=norm(values[r][c]); if ((word.test(s)&&yearKnown)||numeric.test(s)) anchors.push({r,c}); }
  const candidates=[];
  for (const a of anchors) {
    const row=values[a.r]||[], next=anchors.filter(x=>x.r===a.r&&x.c>a.c).sort((x,y)=>x.c-y.c)[0]?.c ?? row.length;
    let plan, fact;
    for(let rr=a.r;rr<Math.min(limit,a.r+8);rr++) for(let cc=a.c;cc<next;cc++) { const label=norm(values[rr]?.[cc]); if(/^план(?:$|[\s,(:/.-])/.test(label)) plan??=cc; if(/^факт(?:$|[\s,(:/.-])/.test(label)) fact??=cc; }
    if(plan!=null&&fact!=null&&plan!==fact)candidates.push({plan,fact,anchor:a});
  }
  const unique=[...new Map(candidates.map(x=>[`${x.plan}:${x.fact}`,x])).values()];
  if(unique.length!==1) throw new Error(unique.length?`Неоднозначная шапка: найдено ${unique.length} пар «План/Факт» за ${months[month-1]} ${year}.`:`Не найдены обе колонки «План» и «Факт» за ${months[month-1]} ${year}.`);
  return [{key:"plan",label:"План",col:unique[0].plan},{key:"fact",label:"Факт",col:unique[0].fact}];
}
function parseArticles(values) {
  const width=Math.min(Math.max(0,...values.map(r=>r?.length||0)),20), counts=Array(width).fill(0);
  for(const row of values)for(let c=0;c<width;c++)if(articleCell(row?.[c]))counts[c]++;
  const articleCol=counts.indexOf(Math.max(...counts)); if(articleCol<0||counts[articleCol]<3)return [];
  const candidates=[];
  for(let r=0;r<values.length;r++){const parsed=articleCell(values[r]?.[articleCol]);if(parsed)candidates.push({row:r,...parsed,codeCol:articleCol});}
  const frequency=new Map(); candidates.forEach(x=>frequency.set(x.code,(frequency.get(x.code)||0)+1));
  const unique=candidates.filter(x=>frequency.get(x.code)===1), codes=new Set(unique.map(x=>x.code));
  return candidates.map(x=>({...x,ambiguous:frequency.get(x.code)>1,parent:frequency.get(x.code)===1&&[...codes].some(c=>c.startsWith(x.code+"."))}));
}
function referencedRows(formula) {
  const rows=[];
  for(const m of String(formula).matchAll(/(?:'[^']+'!)?\$?[A-Z]{1,3}\$?(\d+)(?::(?:'[^']+'!)?\$?[A-Z]{1,3}\$?(\d+))?/gi)) { const a=Number(m[1]),b=Number(m[2]||m[1]); for(let r=Math.min(a,b);r<=Math.max(a,b);r++)rows.push(r-1); }
  return [...new Set(rows)];
}
function audit(values, formulas, monthColumns) {
  const articles = parseArticles(values), validArticles=articles.filter(x=>!x.ambiguous), articleRows=new Set(validArticles.map(x=>x.row)), parents = validArticles.filter(x=>x.parent), issues=[];
  for (const column of monthColumns) for (const p of parents) {
    const prefix=p.code+".", descendants=validArticles.filter(x=>x.code.startsWith(prefix));
    const direct=descendants.filter(x=>x.code.split(".").length===p.code.split(".").length+1);
    const formula=String(formulas[p.row]?.[column.col] ?? ""), shown=String(values[p.row]?.[column.col] ?? "");
    const address=`${colName(column.col)}${p.row+1}`, expected=direct.map(x=>`${colName(column.col)}${x.row+1}`).join(", ");
    if (!formula.startsWith("=")) { issues.push({type:"missing",address,column:column.label,code:p.code,title:p.title,formula:shown||"Пусто",expected,reason:`В колонке «${column.label}» итоговой статьи нет формулы`}); continue; }
    const refs=referencedRows(formula), allowed=new Set(descendants.map(x=>x.row));
    const missed=direct.filter(x=>!refs.includes(x.row)), foreign=refs.filter(r=>articleRows.has(r)&&!allowed.has(r)&&r!==p.row);
    const error=/#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|ERROR!)/i.test(formula+shown);
    if (error||missed.length||foreign.length) {
      const why=[error&&"Формула возвращает ошибку",missed.length&&`Не учтены дочерние строки: ${missed.map(x=>x.row+1).join(", ")}`,foreign.length&&`Есть ссылки вне ветки: ${[...new Set(foreign.map(x=>x+1))].join(", ")}`].filter(Boolean).join("; ");
      issues.push({type:"wrong",address,column:column.label,code:p.code,title:p.title,formula,expected,reason:why});
    }
  }
  return { articles, parents, issues };
}
function render(result, title, heading) {
  state.issues=result.issues; $("#results").classList.remove("hidden"); $("#resultTitle").textContent=`${title} · ${heading}`;
  $("#parents").textContent=result.parents.length; $("#missing").textContent=result.issues.filter(x=>x.type==="missing").length; $("#wrong").textContent=result.issues.filter(x=>x.type==="wrong").length; renderRows(); $("#results").scrollIntoView({behavior:"smooth"});
}
function renderRows() {
  const rows=state.issues.filter(x=>state.filter==="all"||x.type===state.filter); $("#issues").innerHTML=rows.map(x=>{const cellUrl=`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/edit#gid=${state.currentGid}&range=${encodeURIComponent(x.address)}`;return `<tr><td>${escapeHtml(x.month||"—")}</td><td><a class="cell-link" href="${cellUrl}" target="_blank" rel="noopener" title="Открыть и выделить ${x.address}">${x.address}<span aria-hidden="true">↗</span></a></td><td><b>${x.column}</b></td><td><b>${x.code}</b><br>${escapeHtml(x.title)}</td><td><span class="badge ${x.type}">${x.type==="missing"?"Нет формулы":"Неверная"}</span><br><small>${escapeHtml(x.reason)}</small></td><td><code>${escapeHtml(x.formula)}</code></td><td>${escapeHtml(x.expected)||"—"}</td></tr>`;}).join(""); $(".table-wrap").classList.toggle("hidden",!rows.length); $("#empty").classList.toggle("hidden",rows.length>0);
}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

function historyItems(payload) {
  const items=Array.isArray(payload)?payload:(Array.isArray(payload?.items)?payload.items:(Array.isArray(payload?.history)?payload.history:[]));
  return items.filter(item=>item&&typeof item==="object");
}
function historyDate(value) {
  const date=new Date(value); if(Number.isNaN(date.getTime()))return "—";
  return new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Asia/Bishkek"}).format(date);
}
function historyLink(item) {
  const id=String(item.spreadsheetId||"").match(/^[\w-]{20,}$/)?.[0]; if(!id)return "";
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
function historyPeriod(item) {
  if(item.mode==="year")return `Все месяцы ${item.year}`;
  const month=Number(item.month); return month>=1&&month<=12?`${months[month-1]} ${item.year}`:`${item.year||"—"}`;
}
function renderHistory() {
  const items=state.history, summary=state.historySummary;
  $("#historyChecks").textContent=Number(summary.totalRuns??items.length); $("#historyFiles").textContent=Number(summary.uniqueFiles??new Set(items.map(item=>item.spreadsheetId).filter(Boolean)).size);
  $("#historyProblems").textContent=Number(summary.totalIssues??items.reduce((sum,item)=>sum+Number(item.issueCount||0),0));
  $("#historyRows").innerHTML=items.map(item=>{
    const url=historyLink(item), name=item.spreadsheetName||"Google Таблица", sheet=item.sheetName||"—", period=historyPeriod(item);
    const file=url?`<a class="history-file" href="${url}" target="_blank" rel="noopener">${escapeHtml(name)}<span aria-hidden="true">↗</span></a>`:escapeHtml(name);
    const issues=Number(item.issueCount||0), missing=Number(item.missingFormulaCount||0), wrong=Number(item.incorrectFormulaCount||0);
    const details=issues?`<small>${missing} без формулы · ${wrong} неверных</small>`:"<small>Ошибок нет</small>";
    return `<tr><td><time datetime="${escapeHtml(item.createdAt||"")}">${historyDate(item.createdAt)}</time></td><td>${file}</td><td>${escapeHtml(sheet)}</td><td>${escapeHtml(period)}</td><td><b>${Number(item.checkedArticles||0)}</b></td><td><b>${issues}</b>${details}</td></tr>`;
  }).join("");
  $("#historyTable").classList.toggle("hidden",!items.length); $("#historyEmpty").classList.toggle("hidden",items.length>0);
}
async function loadHistory() {
  $("#refreshHistory").disabled=true; $("#historyMessage").textContent="Загружаем журнал…";
  try { const response=await fetch("/api/history?limit=100",{headers:{Accept:"application/json"}}); if(!response.ok)throw new Error("Журнал временно недоступен"); const payload=await response.json(); state.history=historyItems(payload); state.historySummary=payload.summary||{}; state.historyLoaded=true; renderHistory(); $("#historyMessage").textContent=state.history.length?`Показаны последние проверки: ${state.history.length}.`:""; }
  catch(err){$("#historyMessage").textContent=err.message;}
  finally{$("#refreshHistory").disabled=false;}
}
async function saveHistory(entry) {
  try { const response=await fetch("/api/history",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(entry)}); if(!response.ok)throw new Error("Не удалось сохранить запись"); if(state.historyLoaded&&!$("#historyPanel").classList.contains("hidden"))await loadHistory(); }
  catch(err){if(!$("#historyPanel").classList.contains("hidden"))$("#historyMessage").textContent=`Проверка выполнена, но запись в журнал не сохранена: ${err.message}.`;}
}

$("#url").addEventListener("change", async()=>{ state.spreadsheetId=spreadsheetId($("#url").value); state.requestedGid=sheetGid($("#url").value); if(state.spreadsheetId) try { await loadSheets(); } catch {} });
$("#year").addEventListener("change",fillMonths); $("#allMonths").addEventListener("change",e=>{$("#month").disabled=e.target.checked;});
$("#form").addEventListener("submit", async e => { e.preventDefault(); const btn=e.submitter, startedAt=performance.now(); try {
  btn.disabled=true; $("#message").textContent="Читаем общедоступную Google Таблицу…";
  state.spreadsheetId=spreadsheetId($("#url").value); state.requestedGid=sheetGid($("#url").value); if(!state.spreadsheetId)throw new Error("Не удалось распознать ссылку на Google Таблицу."); const titles=await loadSheets(), title=chooseSheet(titles); $("#sheet").value=title; state.currentGid=state.sheetIds[title]||state.requestedGid;
  const range=encodeURIComponent(`'${title.replaceAll("'","''")}'!A1:ZZ2000`); $("#message").textContent="Читаем структуру статей и формулы…";
  const [display,formula]=await Promise.all([api(`/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`),api(`/values/${range}?valueRenderOption=FORMULA`)]);
  const year=Number($("#year").value), requestedMonths=$("#allMonths").checked?months.map((_,i)=>i+1):[Number($("#month").value)], results=[], skipped=[];
  for(const month of requestedMonths){try{const cols=findMonthColumns(display.values||[],month,year,title), part=audit(display.values||[],formula.values||[],cols); part.issues.forEach(x=>x.month=months[month-1]); results.push({month,cols,part});}catch{skipped.push(months[month-1]);}}
  if(!results.length)throw new Error(`Не найдены колонки «План» и «Факт» за ${year} год.`);
  const combined={articles:results[0].part.articles,parents:results[0].part.parents,issues:results.flatMap(x=>x.part.issues)}, heading=$("#allMonths").checked?`Все месяцы ${year}`:`${months[results[0].month-1]} ${year} · ${results[0].cols.map(x=>`${x.label} ${colName(x.col)}`).join(" / ")}`;
  render(combined,title,heading); $("#message").textContent=`Готово. Проверено месяцев: ${results.length}; статей: ${combined.articles.length}.${skipped.length?` Не найдены: ${skipped.join(", ")}.`:""} Изменений в таблице не сделано.`;
  const missing=combined.issues.filter(x=>x.type==="missing").length, wrong=combined.issues.filter(x=>x.type==="wrong").length;
  void saveHistory({spreadsheetId:state.spreadsheetId,spreadsheetUrl:`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/edit`,spreadsheetName:state.spreadsheetTitle||title,sheetName:title,mode:$("#allMonths").checked?"year":"month",year,month:$("#allMonths").checked?null:results[0].month,status:"success",checkedArticles:combined.articles.length,issueCount:combined.issues.length,missingFormulaCount:missing,incorrectFormulaCount:wrong,durationMs:Math.max(0,Math.round(performance.now()-startedAt)),errorMessage:""});
 } catch(err){$("#message").textContent=`Ошибка: ${err.message}`;} finally{btn.disabled=false;} });
document.querySelectorAll(".chip").forEach(b=>b.onclick=()=>{document.querySelectorAll(".chip").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.filter=b.dataset.filter;renderRows();});
$("#export").onclick=()=>{const head=["Месяц","Ячейка","Колонка","Код","Статья","Тип","Причина","Формула","Ожидалось"], csv=[head,...state.issues.map(x=>[x.month,x.address,x.column,x.code,x.title,x.type,x.reason,x.formula,x.expected])].map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(";")).join("\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv"}));a.download="проверка-формул-пнл.csv";a.click();URL.revokeObjectURL(a.href);};
$("#refreshHistory").onclick=loadHistory;
$("#toggleHistory").onclick=()=>{
  const panel=$("#historyPanel"), opening=panel.classList.contains("hidden");
  panel.classList.toggle("hidden",!opening); $("#toggleHistory").setAttribute("aria-expanded",String(opening));
  if(opening&&!state.historyLoaded)void loadHistory();
};
