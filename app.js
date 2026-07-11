// app.js
// Implementa Parte 01, Parte 02 e Parte 03 conforme solicitado.
// Dependências usadas (CDN): Plotly, SheetJS (XLSX), FileSaver

// ---------- Configuração ----------
const CONFIG = {
  OUTLIER_WINDOW: 11,
  OUTLIER_THRESHOLD: 2.0,
  SAMPLE_INTERVAL_MS: 17 * 60 * 1000, // intervalo de amostragem da Parte 03
  COLUMN_MATCH_RATIO: 0.7             // % mínimo de valores válidos para considerar coluna de data/numérica
};

// ---------- Debug ----------
const DEBUG = false;
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// ---------- Estado global da aplicação ----------
const state = {
  shared: { raw: null, fileName: null },     // arquivo compartilhado entre Parte 01 e Parte 03
  part1: { parsed: null },
  part2: { raw: null, concat: null },
  part3: { table: null },
  annotations: []
};

// ---------- Utilitários ----------
const $ = id => document.getElementById(id);
const fmt = (v, d=2) => (isNaN(v) ? '' : Number(v).toFixed(d));
const parseFloatOrNA = s => {
  if (s === undefined || s === null) return NaN;
  const t = String(s).trim();
  if (t === '' || /^N\/A$/i.test(t)) return NaN;
  const v = parseFloat(t.replace(',', '.'));
  return isNaN(v) ? NaN : v;
};

// mensagens
function setMessage(text, isError=false){
  const m = $('messages');
  m.textContent = text;
  m.style.color = isError ? '#ff6b6b' : '#f4f6f9';
  m.style.borderLeftColor = isError ? '#ff6b6b' : '#d9a441';
}

// Drag & drop helper
function makeDropzone(dropEl, inputEl, handler){
  dropEl.addEventListener('click', ()=> inputEl.click());
  inputEl.addEventListener('change', e => {
    if(e.target.files.length) handler(e.target.files[0], dropEl);
  });
  dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.style.borderColor='#888'; });
  dropEl.addEventListener('dragleave', e => { dropEl.style.borderColor='rgba(255,255,255,0.06)'; });
  dropEl.addEventListener('drop', e => {
    e.preventDefault();
    dropEl.style.borderColor='rgba(255,255,255,0.06)';
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if(f) handler(f, dropEl);
  });
  // allow paste
  dropEl.addEventListener('paste', async (e) => {
    const text = e.clipboardData.getData('text/plain');
    if(text) handler(new File([text], 'pasted.txt', {type:'text/plain'}), dropEl);
  });
}

// read file as text
const readFileAsText = file => file.text();

// ---------- Parsing de datas e horas flexível ----------
function tryParseDateTime(s){
  if(!s) return null;
  s = String(s).trim();
  // try patterns, formatos explícitos primeiro (evita ambiguidade dd/mm vs mm/dd do Date.parse nativo):
  // 1) DD/MM/YYYY HH:MM:SS
  // 2) YYYY-MM-DD HH:MM:SS or YYYY/MM/DD HH:MM:SS
  // 3) only HH:MM(:SS) -> assume same day (use today's date)
  // 4) ISO (fallback, só quando nenhum padrão explícito bate)

  // try dd/mm/yyyy hh:mm:ss
  const m1 = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(m1){
    return new Date(`${m1[3]}-${m1[2]}-${m1[1]}T${m1[4]}:${m1[5]}:${m1[6]||'00'}`);
  }
  // try yyyy-mm-dd hh:mm:ss
  const m2 = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T${m2[4]}:${m2[5]}:${m2[6]||'00'}`);

  // try only time hh:mm or hh:mm:ss -> attach today
  const m3 = s.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(m3){
    const d = new Date();
    d.setHours(Number(m3[1]), Number(m3[2]), Number(m3[3]||'0'), 0);
    return d;
  }

  // fallback: ISO puro (ex: 2024-01-02T10:00:00Z) — só chega aqui se nada explícito bateu
  const iso = Date.parse(s);
  if(!isNaN(iso)) return new Date(iso);

  return null;
}

// ---------- Delimiter Detection ----------
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '').slice(0, 5);
  if (lines.length === 0) return null;
  
  // Count occurrences of different delimiters
  const delimiters = [',', '\t', ';', '|'];
  const scores = {};
  
  for (const delim of delimiters) {
    const counts = lines.map(line => {
      // Don't count delimiters inside quotes
      let inQuotes = false;
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuotes = !inQuotes;
        if (line[i] === delim && !inQuotes) count++;
      }
      return count;
    });
    
    // Check if delimiter appears consistently
    const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, c) => sum + Math.pow(c - avgCount, 2), 0) / counts.length;
    
    if (avgCount > 0) {
      scores[delim] = { avg: avgCount, variance: variance, consistency: avgCount / (variance + 1) };
    }
  }
  
  // Check for space-delimited (multiple spaces)
  const spaceCounts = lines.map(line => (line.match(/\s{2,}/g) || []).length);
  const spaceAvg = spaceCounts.reduce((a, b) => a + b, 0) / spaceCounts.length;
  const spaceVariance = spaceCounts.reduce((sum, c) => sum + Math.pow(c - spaceAvg, 2), 0) / spaceCounts.length;
  
  if (spaceAvg > 0) {
    scores['space'] = { avg: spaceAvg, variance: spaceVariance, consistency: spaceAvg / (spaceVariance + 1) };
  }
  
  // Return delimiter with highest consistency score
  let bestDelim = null;
  let bestScore = 0;
  
  for (const [delim, score] of Object.entries(scores)) {
    if (score.consistency > bestScore && score.avg >= 2) {
      bestScore = score.consistency;
      bestDelim = delim;
    }
  }
  
  dlog('Análise de delimitadores:', scores);
  dlog('Delimitador detectado:', bestDelim);
  
  return bestDelim;
}

// ---------- Smart CSV Parser ----------
function parseLine(line, delimiter) {
  if (delimiter === 'space') {
    // Split by multiple spaces, preserving single spaces within values
    return line.split(/\s{2,}/).map(v => v.trim()).filter(v => v !== '');
  }
  
  if (delimiter === '\t') {
    return line.split('\t').map(v => v.trim());
  }
  
  // For comma, semicolon, pipe - handle quotes
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// ---------- Column Detection ----------
function detectColumns(rows) {
  // Analyze first few rows to identify columns
  const sampleSize = Math.min(10, rows.length);
  const sample = rows.slice(0, sampleSize);
  
  // Count columns
  const colCounts = sample.map(r => r.length);
  const maxCols = Math.max(...colCounts);
  const minCols = Math.min(...colCounts);

  dlog(`Colunas detectadas: min=${minCols}, max=${maxCols}`);

  // Try to identify datetime column
  let timeColIndex = -1;
  for (let col = 0; col < maxCols; col++) {
    const colValues = sample.map(r => r[col]).filter(v => v);
    const validDates = colValues.filter(v => tryParseDateTime(v) !== null);
    if (validDates.length >= colValues.length * CONFIG.COLUMN_MATCH_RATIO) {
      timeColIndex = col;
      break;
    }
  }
  
  // Identify numeric columns
  const numericCols = [];
  for (let col = 0; col < maxCols; col++) {
    if (col === timeColIndex) continue;
    const colValues = sample.map(r => r[col]).filter(v => v && v.trim() !== '');
    const validNumbers = colValues.filter(v => !isNaN(parseFloatOrNA(v)));
    if (validNumbers.length >= colValues.length * CONFIG.COLUMN_MATCH_RATIO) {
      numericCols.push(col);
    }
  }
  
  dlog(`Colunas numéricas encontradas: ${numericCols.length} colunas nos índices [${numericCols.join(', ')}]`);
  
  return {
    timeColIndex,
    numericCols,
    totalCols: maxCols
  };
}

// ---------- Outlier removal ----------
function removeOutliersByLocalMedian(points, windowSize=11, threshold=5.0){
  // points: array of {x,y,z,origIndex}
  // windowSize odd
  const n = points.length;
  if(n === 0) return [];
  const half = Math.floor(windowSize/2);
  const keep = new Array(n).fill(true);
  for(let i=0;i<n;i++){
    const start = Math.max(0, i-half);
    const end = Math.min(n-1, i+half);
    const xs=[], ys=[], zs=[];
    for(let k=start;k<=end;k++){ xs.push(points[k].x); ys.push(points[k].y); zs.push(points[k].z); }
    xs.sort((a,b)=>a-b); ys.sort((a,b)=>a-b); zs.sort((a,b)=>a-b);
    const med = (arr)=>arr[Math.floor(arr.length/2)];
    const mx = med(xs), my = med(ys), mz = med(zs);
    const dx = points[i].x - mx;
    const dy = points[i].y - my;
    const dz = points[i].z - mz;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if(dist > threshold) keep[i] = false;
  }
  const out = [];
  for(let i=0;i<n;i++) if(keep[i]) out.push(points[i]);
  return out;
}

// ---------- Arquivo de Entrada Compartilhado (Parte 01 + Parte 03) ----------
makeDropzone($('dropzoneShared'), $('fileInputShared'), async (file) => {
  try{
    setMessage('Lendo arquivo de entrada...');
    state.shared.raw = await readFileAsText(file);
    state.shared.fileName = file.name;
    $('shared-summary').textContent = `Arquivo carregado: ${file.name} — ${state.shared.raw.length} caracteres. Pronto para as Partes 01 e 03.`;
    $('part1-summary').textContent = '';
    $('part3-summary').textContent = '';
    setMessage('Arquivo pronto. Use "Processar Parte 01" e/ou "Processar Parte 03".');
  }catch(err){ setMessage('Erro ao ler o arquivo de entrada', true); console.error(err); }
});

// ---------- Parte 01 Implementation ----------
$('processBtn1').addEventListener('click', ()=> {
  if(!state.shared.raw){ setMessage('Carregue o arquivo de entrada primeiro antes de processar.', true); return; }
  try{
    const tdpVal = $('tdpInput').value; // format "HH:MM"
    processPart1(state.shared.raw, tdpVal);
  }catch(err){
    setMessage('Erro no processamento Parte 01: '+err.message, true);
    console.error(err);
  }
});

async function processPart1(text, tdpHHMM){
  setMessage('Processando Parte 01... Detectando formato do arquivo...');
  
  // Detect delimiter
  const delimiter = detectDelimiter(text);
  if (!delimiter) {
    setMessage('Não foi possível detectar o delimitador do arquivo. Verifique o formato.', true);
    return;
  }
  
  const delimiterName = delimiter === 'space' ? 'espaços múltiplos' : 
                        delimiter === '\t' ? 'tabulação' : 
                        delimiter === ',' ? 'vírgula' : 
                        delimiter === ';' ? 'ponto e vírgula' : delimiter;
  
  dlog(`Usando delimitador: ${delimiterName}`);
  setMessage(`Delimitador detectado: ${delimiterName}. Processando linhas...`);
  
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  
  // Parse all lines using detected delimiter
  const rows = lines.map(line => parseLine(line, delimiter)).filter(r => r.length > 0);
  
  if(rows.length === 0){ 
    setMessage('Arquivo não contém dados válidos.', true); 
    return; 
  }
  
  dlog(`Total de linhas parseadas: ${rows.length}`);
  dlog('Primeira linha:', rows[0]);
  dlog('Segunda linha:', rows[1]);

  // Detect columns
  const columnInfo = detectColumns(rows);
  dlog('Colunas detectadas:', columnInfo);
  
  if(columnInfo.timeColIndex === -1){
    setMessage('Não foi possível identificar a coluna de data/hora automaticamente.', true);
    // Try assuming first column is time
    columnInfo.timeColIndex = 0;
  }
  
  // Check if first row is header
  let dataRows = rows;
  const firstRow = rows[0];
  const hasHeader = firstRow.some(cell => /time|date|hora|data/i.test(cell)) ||
                    (columnInfo.numericCols.length > 0 && isNaN(parseFloatOrNA(firstRow[columnInfo.numericCols[0]])));
  
  if(hasHeader) {
    dataRows = rows.slice(1);
    dlog('Header detectado:', firstRow);
  }
  
  // Map columns to expected positions (assuming standard order after time column)
  const structured = dataRows.map((r, idx) => {
    const timeVal = r[columnInfo.timeColIndex];
    const numericValues = columnInfo.numericCols
      .map(colIdx => r[colIdx])
      .map(v => parseFloatOrNA(v));
    
    // Expect: East_ROV, North_ROV, Height_ROV, DQZ_ROV, Alt_ROV, 
    //         East_TMS, North_TMS, Height_TMS, East_TMSb, North_TMSb, Height_TMSb
    return {
      raw: r,
      timeStr: timeVal,
      time: tryParseDateTime(timeVal),
      eastROV: numericValues[0],
      northROV: numericValues[1],
      heightROV: numericValues[2],
      dqzROV: numericValues[3],
      altROV: numericValues[4],
      eastTMS: numericValues[5],
      northTMS: numericValues[6],
      heightTMS: numericValues[7],
      eastTMSb: numericValues[8],
      northTMSb: numericValues[9],
      heightTMSb: numericValues[10],
      index: idx
    };
  });

  // Remove rows where time is null
  const validRows = structured.filter(r => r.time !== null);
  if(validRows.length === 0){ 
    setMessage('Nenhuma linha com timestamp válido encontrada.', true); 
    return; 
  }

  dlog(`Linhas válidas com timestamp: ${validRows.length}`);

  // Sort by time ascending
  validRows.sort((a,b)=> a.time - b.time);

  // detect start and end times
  const startTime = validRows[0].time;
  const endTime = validRows[validRows.length-1].time;
  $('part1-summary').textContent = `Data/hora início: ${startTime.toISOString()}  —  fim: ${endTime.toISOString()}  — ${validRows.length} linhas processadas (${dataRows.length - validRows.length} linhas sem timestamp ignoradas).`;
  setMessage('Organizando colunas, aplicando regras TDP e removendo N/A...');

  // parse TDP time HH:MM
  let tdpTimeOfDay = null;
  if(tdpHHMM){
    const [hh, mm] = tdpHHMM.split(':').map(x=>Number(x));
    tdpTimeOfDay = hh*3600 + mm*60;
  }

  // compute effective height
  validRows.forEach(r => {
    const tod = r.time.getHours()*3600 + r.time.getMinutes()*60 + r.time.getSeconds();
    if(tdpTimeOfDay === null || tod < tdpTimeOfDay){
      const a = isNaN(r.altROV) ? 0 : r.altROV;
      const d = isNaN(r.dqzROV) ? 0 : r.dqzROV;
      r.effectiveROVHeight = (isNaN(r.altROV) && isNaN(r.dqzROV)) ? NaN : (a + d);
    } else {
      r.effectiveROVHeight = isNaN(r.dqzROV) ? NaN : r.dqzROV;
    }
  });

  // prepare arrays for outlier removal
  const rovPoints = validRows.map((r, i)=>({
    x: r.eastROV,
    y: r.northROV,
    z: r.effectiveROVHeight,
    time: r.time,
    origIndex: r.index,
    row: r
  })).filter(p=>!(isNaN(p.x)||isNaN(p.y)||isNaN(p.z)));

  const tmsPoints = validRows.map((r,i)=>({
    x: r.eastTMS,
    y: r.northTMS,
    z: r.heightTMS,
    time: r.time,
    origIndex: r.index,
    row: r
  })).filter(p=>!(isNaN(p.x)||isNaN(p.y)||isNaN(p.z)));

  dlog(`Pontos ROV válidos: ${rovPoints.length}`);
  dlog(`Pontos TMS válidos: ${tmsPoints.length}`);

  // Remove outliers
  const rovFiltered = removeOutliersByLocalMedian(rovPoints, CONFIG.OUTLIER_WINDOW, CONFIG.OUTLIER_THRESHOLD);
  const tmsFiltered = removeOutliersByLocalMedian(tmsPoints, CONFIG.OUTLIER_WINDOW, CONFIG.OUTLIER_THRESHOLD);

  // Build output lines
  const rovLines = rovFiltered.map(p => {
    const e = fmt(p.x,2);
    const n = fmt(p.y,2);
    const h = fmt(-Math.abs(p.z),2);
    return `XY=${e},${n},${h}`;
  });

  const tmsLines = tmsFiltered.map(p=>{
    const e = fmt(p.x,2);
    const n = fmt(p.y,2);
    const h = fmt(p.z,2);
    return `XY=${e},${n},${h}`;
  });

  // Save to memory
  state.part1.parsed = {rovLines, tmsLines, rovFiltered, tmsFiltered, validRows};

  setMessage(`Processamento Parte 01 concluído. ROV pontos: ${rovFiltered.length}. TMS pontos: ${tmsFiltered.length}. Gerando gráfico 3D...`);

  // Plot 3D
  plot3D(rovFiltered, tmsFiltered);

  // update status
  $('part1-summary').textContent += ` (outliers removidos: ROV ${rovPoints.length - rovFiltered.length}, TMS ${tmsPoints.length - tmsFiltered.length})`;

  // Download automático dos dois arquivos gerados pela Parte 01
  downloadPart1Files();

  // Como a Parte 03 usa o mesmo arquivo de entrada, processa e baixa o XLSX junto
  try{
    processPart3(text);
    setMessage('Download automático concluído: TRACK_ROV.txt, TRACK_TMS.txt e PROFUNDIDADE TMS X ROV.xlsx.');
  }catch(err){
    console.error(err);
    setMessage('Download automático concluído: TRACK_ROV.txt e TRACK_TMS.txt. (Falha ao gerar o XLSX da Parte 03: '+err.message+')', true);
  }
}

// downloads automáticos Parte 01
function downloadPart1Files(){
  if(!state.part1.parsed) return;
  const rovBlob = new Blob([state.part1.parsed.rovLines.join('\n')], {type:'text/plain;charset=utf-8'});
  saveAs(rovBlob, 'TRACK_ROV.txt');
  const tmsBlob = new Blob([state.part1.parsed.tmsLines.join('\n')], {type:'text/plain;charset=utf-8'});
  saveAs(tmsBlob, 'TRACK_TMS.txt');
}

// 3D plotting using Plotly
function plot3D(rovPts, tmsPts){
  const rovTrace = {
    x: rovPts.map(p=>p.x),
    y: rovPts.map(p=>p.y),
    z: rovPts.map(p=>-Math.abs(p.z)),
    mode: 'lines+markers',
    type: 'scatter3d',
    name: 'ROV',
    marker: {size:2, color: '#fceb03'},
    line: {width:2, color: '#fceb03'},
    text: rovPts.map(p=>p.time.toLocaleString('pt-BR')),
    hovertemplate: '<b>ROV</b><br>Height: %{z:.2f}<br>Tempo: %{text}<extra></extra>'
  };
  const tmsTrace = {
    x: tmsPts.map(p=>p.x),
    y: tmsPts.map(p=>p.y),
    z: tmsPts.map(p=>p.z),
    mode: 'lines+markers',
    type: 'scatter3d',
    name: 'TMS',
    marker: {size:2, color: '#fd0000'},
    line: {width:2, color: '#fd0000'},
    text: tmsPts.map(p=>p.time.toLocaleString('pt-BR')),
    hovertemplate: '<b>TMS</b><br>Height: %{z:.2f}<br>Tempo: %{text}<extra></extra>'
  };

  const layout = {
    paper_bgcolor:'#02060c', plot_bgcolor:'#02060c',
    font:{color:'#8ea3bd'},
    scene: {
      xaxis:{title:'', backgroundcolor:'#02060c', gridcolor:'#16304f', showbackground:true},
      yaxis:{title:'', backgroundcolor:'#02060c', gridcolor:'#16304f', showbackground:true},
      zaxis:{title:'Height', backgroundcolor:'#02060c', gridcolor:'#16304f', showbackground:true}
    },
    margin:{l:0, r:0, b:0, t:40},
    legend:{
      x: 0.54,
      y: 0.7,
      xanchor: 'left',
      yanchor: 'top',
      bgcolor: 'rgba(0,0,0,0.7)',
      //bordercolor: '#444',
      //borderwidth: 1,
      font:{color:'#ddd'}
    },
    annotations: state.annotations
  };
  Plotly.newPlot('plot3d', [rovTrace, tmsTrace], layout, {responsive:true}); // CORRIGIDO: removido setupStampInput daqui
}

// Adicionar carimbo - usar textarea com suporte a múltiplas linhas
function setupStampInput(){
  const stampEl = $('stampInput');
  if(!stampEl){
    console.error('Elemento stampInput não encontrado!');
    return;
  }
  
  stampEl.addEventListener('keydown', (e) => {
    // Ctrl+Enter ou Shift+Enter para adicionar o carimbo (permite múltiplas linhas)
    if((e.ctrlKey || e.shiftKey) && e.key === 'Enter' && state.part1.parsed){
      e.preventDefault();
      const text = e.target.value.trim();
      
      if(text){
        state.annotations.push({
          margin:{l:0, r:0, b:0, t:80},
          showarrow: false,          
          text: text.replace(/\n/g, '<br>'),
          x: 0.54,
          y: 0.63 - (state.annotations.length * 0.03),
          xref: 'paper',
          yref: 'paper',
          xanchor: 'left',
          yanchor: 'top',
          font: {size: 12, color: '#fff'},
          //bgcolor: 'rgba(0,0,0,0.7)',
          //bordercolor: '#888',
          borderwidth: 1,
          borderpad: 6
        });
        // Otimização: relayout só atualiza anotações, sem redesenhar os traces 3D inteiros
        Plotly.relayout('plot3d', { annotations: state.annotations });
        e.target.value = '';
        setMessage(`Carimbo adicionado ao gráfico (${state.annotations.length} total).`);
      }
    }
  });
}

// Chamar após o DOM carregar
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', setupStampInput);
} else {
  setupStampInput();
}

// ---------- Parte 02 Implementation ----------
makeDropzone($('dropzone2'), $('fileInput2'), async (file) => {
  try{
    setMessage('Lendo arquivo Parte 02...');
    state.part2.raw = await readFileAsText(file);
    $('part2-summary').textContent = `Arquivo Parte 02 carregado: ${file.name} — ${state.part2.raw.length} caracteres.`;
    setMessage('Arquivo Parte 02 pronto. Aperte "Processar Parte 02".');
    $('downloadConcat').disabled = true;
  }catch(err){ setMessage('Erro ao ler arquivo Parte 02', true); console.error(err); }
});
$('processBtn2').addEventListener('click', ()=> {
  if(!state.part2.raw){ setMessage('Carregue o arquivo Parte 02 primeiro antes de processar.', true); return; }
  try{
    processPart2(state.part2.raw);
  }catch(err){ setMessage('Erro Parte 02: '+err.message, true); console.error(err); }
});

function processPart2(text){
  setMessage('Processando Parte 02...');
  const lines = text.split(/\r?\n/).filter(l=>l.trim() !== '');
  const out = lines.map(l=>{
    // split by comma exactly into 3 components; respect existing signs and separators
    const comps = l.split(',');
    // ensure three components exist; if more, keep first three
    const a = comps[0] ?? '';
    const b = comps[1] ?? '';
    const c = comps.slice(2).join(','); // join() nunca retorna null/undefined
    const ea = fmt(parseFloatOrNA(a),2);
    const eb = fmt(parseFloatOrNA(b),2);
    const ec = fmt(parseFloatOrNA(c),2);
    // but preserve negative sign if value negative; fmt will keep that
    return `XY=${ea},${eb},${ec}`;
  });
  // allow download
  $('downloadConcat').disabled = false;
  state.part2.concat = out;
  $('part2-summary').textContent = `Parte 02 processada: ${out.length} linhas.`;
  setMessage('Parte 02 pronta para download.');
}

$('downloadConcat').addEventListener('click', ()=> {
  const out = state.part2.concat;
  if(!out){ setMessage('Não há dados processados na Parte 02.', true); return; }
  const blob = new Blob([out.join('\n')], {type:'text/plain;charset=utf-8'});
  saveAs(blob, 'CONCATENADO.txt');
});

// ---------- Parte 03 Implementation ----------
$('processBtn3').addEventListener('click', ()=> {
  if(!state.shared.raw){ setMessage('Carregue o arquivo de entrada primeiro antes de processar.', true); return; }
  try{ processPart3(state.shared.raw); } catch(err){ setMessage('Erro Parte 03: '+err.message, true); console.error(err); }
});

function processPart3(text){
  setMessage('Processando Parte 03...');
  const lines = text.split(/\r?\n/).filter(l=>l.trim() !== '');
  // Build rows similar to Part1
  const rows = [];
  for(const ln of lines){
    const cols = ln.split(',');
    if(cols.length < 3) continue;
    // We expect timestamp col present in original file: if not, try to infer
    rows.push(cols.map(c=>c.trim()));
  }
  // Attempt to find timestamp column (like part1)
  let structured = [];
  // Here we expect file has timestamp in first column like part1; otherwise try to parse first token
  for(let i=0;i<lines.length;i++){
    const cols = lines[i].split(',').map(s=>s.trim());
    // heuristic: if first col can be parsed as date use it, else try to find any col that parses
    structured.push(cols);
  }
  // We'll attempt to recreate "validRows" similar to part1: we need time and ROV Height (col4) and TMS Height (col9)
  // Because input may be same as Parte 01, we re-run a similar parser: attempt to map columns.
  const allRows = structured.map(r => {
    // pad to 12
    while(r.length < 12) r.push('N/A');
    return r;
  });

  const items = allRows.map((r,i)=>({
    raw: r,
    time: tryParseDateTime(r[0]),
    eastROV: parseFloatOrNA(r[1]),
    northROV: parseFloatOrNA(r[2]),
    heightROV: Math.abs(parseFloatOrNA(r[3])),
    dqzROV: parseFloatOrNA(r[4]),
    altROV: parseFloatOrNA(r[5]),
    eastTMS: parseFloatOrNA(r[6]),
    northTMS: parseFloatOrNA(r[7]),
    heightTMS: Math.abs(parseFloatOrNA(r[8])),
  })).filter(x => x.time !== null);

  if(items.length === 0){ setMessage('Nenhuma linha com timestamp encontrado para Parte 03.', true); return; }

  // Sort and then select rows every 17 minutes (take first then +17min and so on)
  items.sort((a,b)=>a.time - b.time);
  const selected = [];
  let lastSelectedTime = items[0].time;
  selected.push(items[0]);
  for(let i=1;i<items.length;i++){
    if(items[i].time - lastSelectedTime >= CONFIG.SAMPLE_INTERVAL_MS){
      selected.push(items[i]);
      lastSelectedTime = items[i].time;
    }
  }
  // Format heights: 1 decimal, replace '.' by ',' for heights columns (ROV and TMS)
  const tableRows = selected.map(x=>{
    const dateStr = `${String(x.time.getDate()).padStart(2,'0')}/${String(x.time.getMonth()+1).padStart(2,'0')}/${x.time.getFullYear()}`;
    const timeStr = `${String(x.time.getHours()).padStart(2,'0')}:${String(x.time.getMinutes()).padStart(2,'0')}:${String(x.time.getSeconds()).padStart(2,'0')}`;
    const rovHeight = x.heightROV;
    const tmsHeight = x.heightTMS;
    const rov1 = isNaN(rovHeight) ? '' : Number(rovHeight).toFixed(1).replace('.',',');
    const tms1 = isNaN(tmsHeight) ? '' : Number(tmsHeight).toFixed(1).replace('.',',');
    const diffVal = (isNaN(rovHeight) || isNaN(tmsHeight)) ? NaN : (rovHeight - tmsHeight);
    const diff = isNaN(diffVal) ? '' : Number(diffVal).toFixed(1).replace('.',',');
    return {
      DATA: dateStr,
      HORA: timeStr,
      ROV: rov1,
      TMS: tms1,
      DIFERENCA: diff
    };
  });

  // Build HTML table
  const container = $('table3container');
  container.innerHTML = '';
  if(tableRows.length === 0){ container.textContent = 'Nenhuma linha selecionada para 17min.'; }
  else{
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const titles = ['DATA','HORA','ROV','TMS','DIFERENÇA'];
    const trh = document.createElement('tr');
    titles.forEach(t => { const th = document.createElement('th'); th.textContent = t; trh.appendChild(th); });
    thead.appendChild(trh); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    tableRows.forEach(r=>{
      const tr = document.createElement('tr');
      titles.forEach(t => { const td = document.createElement('td'); td.textContent = r[t]; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  $('part3-summary').textContent = `Parte 03 processada — linhas originais: ${items.length}, linhas selecionadas (17min): ${tableRows.length}.`;
  setMessage('Parte 03 concluída. Pronto para gerar XLSX.');

  // Plot depths using Plotly: time vs depth (ROV and TMS)
  const times = selected.map(s => s.time);
  const rovTrace = { x: times, y: selected.map(s=>s.heightTMS), name:'TMS', mode:'lines+markers', type:'scatter', line:{color:'#f4f807'}, marker:{color:'#f4f807'} };
  const tmsTrace = { x: times, y: selected.map(s=>s.heightROV), name:'ROV', mode:'lines+markers', type:'scatter', line:{color:'#d30505'}, marker:{color:'#d30505'} };
  const layout = { paper_bgcolor:'#02060c', plot_bgcolor:'#02060c', font:{color:'#8ea3bd'}, xaxis:{title:'Hora', tickformat:'%H:%M', gridcolor:'#16304f'}, yaxis:{title:'Profundidade', gridcolor:'#16304f'}, legend:{font:{color:'#ddd'}}, margin:{t:10} };
  //Plotly.newPlot('plotDepth', [rovTrace, tmsTrace], layout, {responsive:true});

  state.part3.table = tableRows;

  // Download automático da planilha XLSX
   downloadPart3Xlsx();
}

// download automático Parte 03
function downloadPart3Xlsx(){
  const rows = state.part3.table;
  if(!rows || rows.length===0){ setMessage('Nenhuma tabela pronta para download XLSX.', true); return; }
  // create worksheet
  const ws_data = [['DATA','HORA','ROV','TMS','DIFERENÇA'], ...rows.map(r=>[r.DATA,r.HORA,r.ROV,r.TMS,r.DIFERENCA])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(ws_data);
  XLSX.utils.book_append_sheet(wb, ws, 'Profundidades');
  const wbout = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  saveAs(new Blob([wbout],{type:'application/octet-stream'}), 'PROFUNDIDADE TMS X ROV.xlsx');
  setMessage('Download automático concluído: PROFUNDIDADE TMS X ROV.xlsx.');
}

// ---------- Inicializações ----------
setMessage('Pronto. Carregue um arquivo em qualquer das áreas de entrada.');
