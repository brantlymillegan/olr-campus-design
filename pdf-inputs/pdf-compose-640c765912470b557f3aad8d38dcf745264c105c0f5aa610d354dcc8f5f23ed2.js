/* Browser-only campus handout composition. jsPDF and svg2pdf are verified,
 * same-origin UMD dependencies loaded by the download handler on demand.
 * Maps stay vector; all headings, map labels and specifications stay text.
 */
const WIDTH = 1224, HEIGHT = 792, MARGIN = 36, BOTTOM = 750;
const INK = '#1a2430', BLUE = '#153b5b', MUTED = '#536071';
const num = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1});
const dimNum = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const clean = value => String(value ?? '').replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, '...').replace(/\u00a0/g, ' ');
const fmt = value => num.format(Number(value) || 0);
const sf = value => `${fmt(value)} SF`;
const signed = value => `${value > 0 ? '+' : ''}${fmt(value)}`;
const dimensions = value => `${dimNum.format(value.width)} × ${dimNum.format(value.depth)} ft${value.overall ? ' overall' : ''}`;
const floorName = value => Number(value) === 1 ? '1st floor' : '2nd floor';
const fixtureText = value => [['wc', 'toilet'], ['urinal', 'urinal'], ['sink', 'sink']]
  .filter(([key]) => value?.[key]).map(([key, label]) => `${fmt(value[key])} ${label}${value[key] === 1 ? '' : 's'}`).join(' · ') || '-';
const invariant = (test, message) => { if (!test) throw new Error(message); };
const cell = (text, detail = '', options = {}) => ({text: clean(text), detail: clean(detail), ...options});

/**
 * assets: {data: immutable inputs JSON, logo: Uint8Array,
 *          maps: Map<map.id, SVG string> (or a plain object)}.
 * perspectives: [{id, title, bytes: Uint8Array, width, height}].
 * downloadedAt is the Date captured by the click handler, in the user's locale.
 * Returns {bytes: Uint8Array, filename, pageCount, pages, roomIds}.
 */
export async function createCampusPdf({manifest, assets, perspectives, downloadedAt, signal, onProgress = () => {}}) {
  const check = () => { if (signal?.aborted) throw signal.reason || new DOMException('Download cancelled', 'AbortError'); };
  const pause = async message => { check(); onProgress(message); await new Promise(resolve => setTimeout(resolve, 0)); check(); };
  const data = assets?.data, specs = data?.specs, cover = data?.cover;
  invariant(data && cover && specs?.summary && Array.isArray(specs.rooms), 'Complete campus PDF inputs are required.');
  invariant(data.maps?.length === 4 && Array.isArray(data.perspectives) && data.perspectives.length > 0 && data.perspectives.length <= 8 && perspectives?.length === data.perspectives.length, 'The PDF requires four vector maps and every current campus view.');
  invariant(new Set(data.perspectives.map(view => view.id)).size === data.perspectives.length && new Set(perspectives.map(view => view.id)).size === perspectives.length && data.perspectives.every(view => perspectives.some(captured => captured.id === view.id)), 'Every requested campus view must be captured exactly once.');
  invariant(new Set(specs.rooms.map(room => room.id)).size === specs.rooms.length, 'Room IDs must be unique.');
  invariant(specs.summary.roomCount === specs.rooms.length, 'The complete room schedule is required.');
  invariant(globalThis.jspdf?.jsPDF && globalThis.svg2pdf, 'The verified PDF libraries have not loaded.');
  const clickDate = downloadedAt instanceof Date ? new Date(downloadedAt.valueOf()) : new Date(downloadedAt);
  invariant(Number.isFinite(clickDate.valueOf()), 'The download date is invalid.');
  const pad = n => String(n).padStart(2, '0');
  const filename = `OLR-Master-Plan-Millegan-${pad(clickDate.getMonth() + 1)}-${pad(clickDate.getDate())}-${clickDate.getFullYear()}.pdf`;
  const dateLabel = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'long', day: 'numeric'}).format(clickDate);
  const doc = new globalThis.jspdf.jsPDF({orientation: 'landscape', unit: 'pt', format: [WIDTH, HEIGHT], compress: true, putOnlyUsedFonts: true, floatPrecision: 16});
  doc.setCreationDate(clickDate);
  doc.setProperties({title: cover.title, author: cover.author, subject: 'Our Lady of the Rosary campus master plan', creator: 'OLR Campus'});
  const timestamp = clickDate.toISOString();
  doc.addMetadata(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>${timestamp}</xmp:CreateDate><xmp:ModifyDate>${timestamp}</xmp:ModifyDate><xmp:MetadataDate>${timestamp}</xmp:MetadataDate></rdf:Description></rdf:RDF></x:xmpmeta>`, true);
  doc.setLanguage('en-US');
  const pages = [], roomIds = [], rooms = new Map(specs.rooms.map(room => [room.id, room]));
  const categories = new Map(specs.categories.map(category => [category.id, category]));
  const lineHeight = (size, factor = 1.25) => size * factor;
  function font(size = 11, bold = false, color = INK, family = 'helvetica') {
    doc.setFont(family, bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(color);
  }
  function lines(text, width, size = 11, bold = false) {
    font(size, bold); return doc.splitTextToSize(clean(text), width);
  }
  function text(text, x, y, {size = 11, bold = false, color = INK, width, align = 'left', family = 'helvetica'} = {}) {
    font(size, bold, color, family);
    const value = width ? doc.splitTextToSize(clean(text), width) : clean(text);
    doc.text(value, x, y, {align, baseline: 'top', lineHeightFactor: 1.25});
    return y + (Array.isArray(value) ? value.length : value.split('\n').length) * lineHeight(size);
  }
  function paragraph(value, x, y, width, options = {}) {
    return text(value, x, y, {...options, width}) + (options.gap ?? 6);
  }
  function rect(x, y, width, height, fill = '#f3f7fa', stroke = '#d8e1e8') {
    doc.setFillColor(fill); doc.setDrawColor(stroke); doc.setLineWidth(.6); doc.rect(x, y, width, height, 'FD');
  }
  function line(x1, y1, x2, y2, color = '#d8e1e8', weight = .6) { doc.setDrawColor(color); doc.setLineWidth(weight); doc.line(x1, y1, x2, y2); }
  function image(bytes, format, x, y, width, height, alias) { doc.addImage(bytes, format, x, y, width, height, alias, 'FAST'); }
  function header(title, eyebrow = 'OLR CAMPUS') {
    image(assets.logo, 'PNG', MARGIN, 18, 31.5, 31.5, 'olr-logo');
    text(eyebrow, 77, 20, {size: 7.5, color: MUTED});
    text(title, 77, 32, {size: 17.25, bold: true});
  }
  function page(title, record = {}, eyebrow) {
    if (pages.length) doc.addPage([WIDTH, HEIGHT], 'landscape');
    pages.push({number: pages.length + 1, title, ...record});
    header(title, eyebrow); return pages[pages.length - 1];
  }
  function fitImage(view, x, y, width, height) {
    invariant(view?.bytes instanceof Uint8Array || typeof view?.dataUrl === 'string', `Missing image for ${view?.id || 'campus view'}.`);
    invariant(view.width > 0 && view.height > 0, `Invalid image dimensions for ${view.id}.`);
    const ratio = Math.min(width / view.width, height / view.height), w = view.width * ratio, h = view.height * ratio;
    image(view.bytes || view.dataUrl, 'JPEG', x + (width - w) / 2, y + (height - h) / 2, w, h, `perspective-${view.id}`);
  }
  function table(headers, rows, x, y, widths, options = {}) {
    const size = options.size ?? 10.4, detailSize = options.detailSize ?? 9, padding = options.padding ?? 6;
    const normalized = rows.map(row => row.map(value => typeof value === 'object' ? value : cell(value)));
    const rowParts = row => row.map((value, i) => ({...value,
      main: lines(value.text, widths[i] - 2 * padding, size, value.bold || false),
      small: value.detail ? lines(value.detail, widths[i] - 2 * padding, detailSize) : []}));
    const headerParts = headers.map((value, i) => lines(value, widths[i] - 2 * padding, options.headerSize ?? 9.5, true));
    const headerHeight = Math.max(...headerParts.map(v => v.length)) * lineHeight(options.headerSize ?? 9.5) + padding * 2;
    rect(x, y, widths.reduce((a, b) => a + b, 0), headerHeight, '#eaf0f5', '#cfdae3');
    let cx = x;
    headerParts.forEach((value, i) => {text(value.join('\n'), cx + padding, y + padding, {size: options.headerSize ?? 9.5, bold: true, color: BLUE}); cx += widths[i];});
    y += headerHeight;
    normalized.forEach((row, index) => {
      const cells = rowParts(row);
      const height = Math.max(...cells.map(value => value.main.length * lineHeight(size) + (value.small.length ? 2 + value.small.length * lineHeight(detailSize) : 0))) + padding * 2;
      invariant(y + height <= (options.bottom ?? BOTTOM), `The ${pages.at(-1)?.title} table exceeds its page. Please update its pagination.`);
      if (options.lastTotal && index === normalized.length - 1 || index % 2) rect(x, y, widths.reduce((a, b) => a + b, 0), height, options.lastTotal && index === normalized.length - 1 ? '#edf2f6' : '#f7f9fb', '#ffffff');
      cx = x;
      cells.forEach((value, i) => {
        const right = value.align === 'right', tx = right ? cx + widths[i] - padding : cx + padding;
        let ty = text(value.main.join('\n'), tx, y + padding, {size, bold: value.bold || options.lastTotal && index === normalized.length - 1, align: right ? 'right' : 'left'});
        if (value.small.length) text(value.small.join('\n'), tx, ty + 2, {size: detailSize, color: MUTED, align: right ? 'right' : 'left'});
        cx += widths[i];
      });
      y += height; line(x, y, x + widths.reduce((a, b) => a + b, 0), y);
    });
    return y;
  }
  async function vectorMap(map) {
    const source = assets.maps instanceof Map ? assets.maps.get(map.id) : assets.maps?.[map.id];
    invariant(typeof source === 'string', `Missing vector map: ${map.title}.`);
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    invariant(!parsed.querySelector('parsererror') && parsed.documentElement.localName === 'svg', `Invalid map SVG: ${map.title}.`);
    const svg = document.importNode(parsed.documentElement, true);
    invariant(!svg.querySelector('script,foreignObject,image'), 'PDF maps must be self-contained vector artwork.');
    for (const element of svg.querySelectorAll('*')) {
      for (const attr of [...element.attributes]) invariant(!/^on/i.test(attr.name) && !((attr.name === 'href' || attr.name === 'xlink:href') && !attr.value.startsWith('#')), 'External resources are not allowed in PDF maps.');
      // The embedded PDF base font matches the Arial-compatible map typography.
      if (element.localName === 'text' || element.localName === 'tspan') {
        element.setAttribute('font-family', 'helvetica'); element.style.fontFamily = 'helvetica';
        // Base PDF fonts contain Latin-1. Keep mathematical/arrow meaning with
        // ASCII equivalents instead of emitting broken, non-searchable glyphs.
        for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE)
          child.nodeValue = clean(child.nodeValue).replace(/≈/g, '~').replace(/→/g, '->');
      }
    }
    svg.setAttribute('width', String(map.width)); svg.setAttribute('height', String(map.height));
    const mount = document.createElement('div'); mount.setAttribute('aria-hidden', 'true'); mount.inert = true;
    mount.style.cssText = 'position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none;contain:layout style;';
    mount.append(svg); document.body.append(mount);
    try {
      const crop = svg.querySelector('clipPath[id$="export-crop"] rect');
      let labelsRemoved = 0, statuesRemoved = 0;
      if (crop) {
        const viewport = svg.getBoundingClientRect(), viewBox = svg.viewBox.baseVal;
        const sx = viewport.width / viewBox.width, sy = viewport.height / viewBox.height;
        const left = viewport.left + (crop.x.baseVal.value - viewBox.x) * sx, top = viewport.top + (crop.y.baseVal.value - viewBox.y) * sy;
        const right = left + crop.width.baseVal.value * sx, bottom = top + crop.height.baseVal.value * sy;
        const outside = box => box.left < left - .01 || box.right > right + .01 || box.top < top - .01 || box.bottom > bottom + .01;
        for (const statue of svg.querySelectorAll('[data-statue-feature]')) if (outside(statue.getBoundingClientRect())) {
          const id = statue.getAttribute('data-statue-feature');
          for (const label of svg.querySelectorAll('[data-statue-label]')) if (label.getAttribute('data-statue-label') === id) label.remove();
          statue.remove(); statuesRemoved++;
        }
        for (const label of svg.querySelectorAll('text')) if (outside(label.getBoundingClientRect())) { label.remove(); labelsRemoved++; }
      }
      check(); await doc.svg(svg, {x: MARGIN, y: 55.5, width: WIDTH - 2 * MARGIN, height: 697.5}); check();
      return {crop_edge_labels_removed: labelsRemoved, crop_edge_statues_removed: statuesRemoved, vector_image_count: 0};
    } finally { mount.remove(); }
  }
  function compass(map) {
    const angle = Number(map.geographic_north_rotation_degrees ?? map.north_rotation_degrees ?? 0) * Math.PI / 180;
    const cx = WIDTH - 54, cy = 35, rotate = (x, y) => [cx + x * Math.cos(angle) - y * Math.sin(angle), cy + x * Math.sin(angle) + y * Math.cos(angle)];
    const pts = [[0,-12],[4.5,6],[0,2],[-4.5,6]].map(([x,y]) => rotate(x,y));
    doc.setFillColor(INK); doc.lines(pts.slice(1).concat([pts[0]]).map((pt, i) => [pt[0]-pts[i][0],pt[1]-pts[i][1]]), pts[0][0], pts[0][1], [1,1], 'F', true);
    const p = rotate(0, -20); text('N', p[0], p[1], {size: 7.5, bold: true, align: 'center'});
    const width = map.scale_bar_ft * map.scale_px_per_ft * .75, x = (WIDTH - width) / 2;
    line(x, 765, x + width, 765, MUTED, .9); line(x, 762, x, 768, MUTED, .9); line(x + width, 762, x + width, 768, MUTED, .9);
    text(`${map.scale_bar_ft} ft`, WIDTH/2, 754, {size: 7.5, color: MUTED, align: 'center'});
  }

  await pause('Composing the proposal cover…');
  pages.push({number:1,title:cover.title,type:'cover',date:dateLabel,view_id:cover.hero_view_id});
  image(assets.logo, 'PNG', MARGIN, 24, 31.5, 31.5, 'olr-logo');
  // Cover uses the same current playground image that appears among the views.
  image(assets.logo, 'PNG', (WIDTH-78)/2, 24, 78, 78, 'olr-logo');
  text(cover.organization, WIDTH/2, 112, {size:22.5, color:'#123557', family:'times', align:'center'});
  text(cover.title, WIDTH/2, 141, {size:34.5, color:'#123557', family:'times', align:'center'});
  text(`by ${cover.author}`, WIDTH/2, 187, {size:13.5, color:'#123557', align:'center'});
  text(dateLabel, WIDTH/2, 208, {size:12, color:'#123557', align:'center'});
  text(cover.website, WIDTH/2, 229, {size:12, color:'#24568a', align:'center'});
  const website = /^https?:\/\//.test(cover.website) ? cover.website : `https://${cover.website}`;
  font(12); const urlWidth = doc.getTextWidth(cover.website); doc.link((WIDTH-urlWidth)/2,229,urlWidth,15,{url:website});
  const hero = perspectives.find(view => view.id === cover.hero_view_id);
  invariant(hero, 'The playground cover perspective is missing.');
  fitImage(hero, (WIDTH-825)/2, 254, 825, 499.5); line(MARGIN, 757, WIDTH-MARGIN, 757, '#d7bd86');

  for (const map of data.maps) {
    await pause(`Composing ${map.title}…`);
    const record = page(map.title, {type: 'vector-map', id: map.id, room_count: map.room_count});
    Object.assign(record, await vectorMap(map)); compass(map);
  }
  for (const definition of data.perspectives || perspectives) {
    const view = perspectives.find(value => value.id === definition.id);
    await pause(`Adding ${definition.title}…`);
    page(definition.title, {type:'3d-perspective',view_id:definition.id});
    fitImage(view, MARGIN, 55.5, WIDTH-2*MARGIN, 697.5);
  }

  await pause('Composing building specifications…');
  page('New building specifications', {type:'building-specifications',section:'overview',category_ids:specs.categories.map(v=>v.id)}, 'OLR CAMPUS · LIST');
  paragraph(`Room sizes, teaching spaces, facilities, and totals for ${specs.buildings.map(building=>building.name).join(', ')}.`, MARGIN, 68, WIDTH-2*MARGIN, {size:12.5,color:MUTED});
  const summary = specs.summary, gap = 11, cardWidth = (WIDTH-2*MARGIN-3*gap)/4;
  const stats = [
    ['Total building area',sf(summary.grossSf),'Gross floor area · all listed floors combined'],
    ['Listed rooms & floor spaces',fmt(summary.roomCount),`${sf(summary.netRoomSf)} of net room area`],
    ['Classrooms',fmt(summary.classrooms.grade+summary.classrooms.specialist),`${summary.classrooms.grade} grade + ${summary.classrooms.specialist} specialist; ${summary.classrooms.spare} spare rooms separate`],
    ['Restroom fixtures',`${summary.fixtures.wc} toilets`,`${summary.fixtures.urinal} urinals · ${summary.fixtures.sink} sinks · ${summary.restroomRoomCount} restroom spaces`]
  ];
  stats.forEach(([title,value,note],i)=>{const x=MARGIN+i*(cardWidth+gap);rect(x,99,cardWidth,80);text(title,x+11,109,{size:10,color:MUTED});text(value,x+11,126,{size:21,bold:true});paragraph(note,x+11,154,cardWidth-22,{size:9.5,color:MUTED});});
  const columnWidth=560, rightX=628;
  let y=paragraph('By building and floor',MARGIN,196,columnWidth,{size:15,bold:true,color:BLUE});
  for (const building of specs.buildings) {
    y=paragraph(building.name,MARGIN,y,columnWidth,{size:12,bold:true,gap:3});
    y=paragraph(building.shapeNote || dimensions(building.dimensions),MARGIN,y,columnWidth,{size:9.5,gap:5});
    const rows=building.floors.map(f=>[cell(floorName(f.floor), '', {bold:true}),fmt(f.roomCount),fmt(f.grossSf),fmt(f.netRoomSf),fixtureText(f.fixtures)]);
    rows.push(['Total',fmt(building.roomCount),fmt(building.grossSf),fmt(building.netRoomSf),fixtureText(building.fixtures)]);
    y=table(['Floor','Spaces','Gross SF','Net room SF','Fixtures'],rows,MARGIN,y,[88,48,78,87,259],{size:9.3,headerSize:8.9,padding:4,lastTotal:true})+12;
  }
  if(specs.bridge) {y=paragraph('Connecting walk / bridge',MARGIN,y,columnWidth,{size:10.5,bold:true,gap:3});y=paragraph(`${specs.bridge.description} Dimensions: ${dimensions(specs.bridge.dimensions)}.`,MARGIN,y,columnWidth,{size:9.4,gap:10});}
  let ry=paragraph('By use',rightX,196,columnWidth,{size:15,bold:true,color:BLUE});
  ry=paragraph('Each listed space belongs to one category. Subtotals include all proposed buildings and their listed floors.',rightX,ry,columnWidth,{size:9.5,gap:6});
  const categoryRows=specs.categories.map(c=>[cell(c.name,c.description),cell(fmt(c.roomCount),'',{align:'right'}),cell(fmt(c.areaSf),'',{align:'right'})]);
  categoryRows.push(['All listed spaces',cell(fmt(summary.roomCount),'',{align:'right'}),cell(fmt(summary.netRoomSf),'',{align:'right'})]);
  ry=table(['Category','Spaces','Net SF'],categoryRows,rightX,ry,[398,64,98],{size:9.8,detailSize:8.5,padding:3,lastTotal:true})+10;
  const totalsNote=`Gross building area includes the whole floor plate. Net room area totals the individually listed spaces. The remaining ${sf(summary.otherSf)} includes walls, circulation and other unlisted floor area.`;
  const totalsHeight=lineHeight(10.5)+3+lines(totalsNote,columnWidth,9.4).length*lineHeight(9.4)+6;
  const deferTotals=ry+totalsHeight>BOTTOM;
  if(!deferTotals){
    ry=paragraph('How the totals add up',rightX,ry,columnWidth,{size:10.5,bold:true,gap:3});
    ry=paragraph(totalsNote,rightX,ry,columnWidth,{size:9.4});
  }
  invariant(ry<=BOTTOM, 'Category totals exceed the specifications page.');
  const scheduleNotes=(specs.notes||[]).map(note=>`• ${typeof note==='string'?note:note.text||note.description||''}`);
  const notesHeight=lineHeight(13)+7+scheduleNotes.reduce((height,note)=>height+lines(note,columnWidth,9.3).length*lineHeight(9.3)+4,0);
  let notesWidth=columnWidth;
  if(deferTotals||y+notesHeight>BOTTOM){
    page('Reading this schedule',{type:'building-specifications',section:'notes'},'OLR CAMPUS · LIST');
    y=68;notesWidth=WIDTH-2*MARGIN;
    if(deferTotals){
      y=paragraph('How the totals add up',MARGIN,y,notesWidth,{size:10.5,bold:true,gap:3});
      y=paragraph(totalsNote,MARGIN,y,notesWidth,{size:9.4,gap:14});
    }
  }else{
    y=paragraph('Reading this schedule',MARGIN,y,notesWidth,{size:13,bold:true,color:BLUE,gap:7});
  }
  for(const note of scheduleNotes) y=paragraph(note,MARGIN,y,notesWidth,{size:9.3,gap:4});
  invariant(y<=BOTTOM, 'Building notes exceed the specifications page.');

  if(specs.comparison) {
    await pause('Composing current and proposed comparisons…');
    const comparison=specs.comparison, baselines=new Map(comparison.baselines.map(v=>[v.id,v]));
    page('Current and proposed spaces',{type:'building-specifications',section:'comparisons',comparison_group_ids:comparison.groups.map(v=>v.id)},'OLR CAMPUS · LIST');
    let cy=paragraph(comparison.sourceNote,MARGIN,68,WIDTH-2*MARGIN,{size:11.5,color:MUTED,gap:12});
    const cols=comparison.groups.length, width=(WIDTH-2*MARGIN-(cols-1)*18)/cols;
    let cardBottom=cy;
    comparison.groups.forEach((group,index)=>{
      const baseline=baselines.get(group.baselineId);invariant(baseline,'Current baseline missing.');
      const proposed=group.roomIds.map(id=>{invariant(rooms.has(id),`Missing comparison room: ${id}`);return rooms.get(id);});
      const areas=[...new Set(proposed.map(v=>v.areaSf))], sizes=[...new Set(proposed.map(v=>dimensions(v.dimensions)))];
      const x=MARGIN+index*(width+18);rect(x,cy,width,189,'#f7fafc');
      let yy=paragraph(group.name,x+14,cy+13,width-28,{size:14,bold:true,color:BLUE,gap:5});
      yy=paragraph('PER CLASSROOM',x+14,yy,width-28,{size:8.5,color:MUTED,gap:9});
      const right=x+width/2;
      text('Current',x+14,yy,{size:10.5,color:MUTED});text('Proposed',right,yy,{size:10.5,color:MUTED});yy+=17;
      text(sf(baseline.areaSf),x+14,yy,{size:18,bold:true});text(areas.map(sf).join(' / '),right,yy,{size:18,bold:true});yy+=26;
      text(dimensions(baseline.dimensions),x+14,yy,{size:10.5});text(sizes.join(' or '),right,yy,{size:10.5});yy+=22;
      if(areas.length===1){const change=areas[0]-baseline.areaSf;yy=paragraph(`${signed(change)} SF per classroom (${signed(change/baseline.areaSf*100)}%)`,x+14,yy,width-28,{size:12.5,bold:true,color:BLUE,gap:6});}
      yy=paragraph(`Proposed group: ${fmt(group.roomCount)} classrooms · ${sf(group.proposedAreaSf)} total.`,x+14,yy,width-28,{size:10,gap:5});
      yy=paragraph(group.scopeNote,x+14,yy,width-28,{size:9,color:MUTED});
      invariant(yy<=cy+189, 'Classroom comparison card exceeds its bounds.');cardBottom=Math.max(cardBottom,cy+189);
    });
    cy=cardBottom+13;
    if(comparison.upperSchool) {const baseline=baselines.get(comparison.upperSchool.baselineId);if(baseline){cy=paragraph(`${baseline.name}: ${sf(baseline.areaSf)}`,MARGIN,cy,WIDTH-2*MARGIN,{size:11,bold:true,gap:4});cy=paragraph(`${dimensions(baseline.dimensions)}. ${comparison.upperSchool.scopeNote}`,MARGIN,cy,WIDTH-2*MARGIN,{size:10,color:MUTED,gap:14});}}
    if(comparison.office) {
      const office=comparison.office;
      cy=paragraph('Office and staff spaces',MARGIN,cy,WIDTH-2*MARGIN,{size:15,bold:true,color:BLUE,gap:5});
      cy=paragraph(office.scopeNote,MARGIN,cy,WIDTH-2*MARGIN,{size:10.5,gap:12});
      const packages=[{name:'Current office package',rows:[cell('School office',dimensions(office.currentOfficeDimensions||baselines.get('office').dimensions)),cell('Break room + bathroom',dimensions(office.currentStaffAreaDimensions||baselines.get('office-staff-area').dimensions))],areas:[office.currentOfficeSf,office.currentStaffAreaSf],areaSf:office.currentCombinedSf},...office.proposedPackages.map(pkg=>({...pkg,name:`Proposed: ${pkg.name}`,rows:pkg.roomIds.map(id=>{const r=rooms.get(id);invariant(r,`Missing office room: ${id}`);return cell(r.name,dimensions(r.dimensions));}),areas:pkg.roomIds.map(id=>rooms.get(id).areaSf)}))];
      const w=(WIDTH-2*MARGIN-(packages.length-1)*12)/packages.length;
      let packageBottom=cy;
      for(const [i,pkg] of packages.entries()) {
        const x=MARGIN+i*(w+12);let yy=paragraph(pkg.name,x+8,cy,w-16,{size:11.5,bold:true,gap:8});
        // Equal title height keeps the adjacent comparison tables aligned.
        yy=Math.max(yy,cy+38);
        const rows=pkg.rows.map((r,j)=>[r,cell(sf(pkg.areas[j]),'',{align:'right'})]);rows.push(['Combined',cell(sf(pkg.areaSf),'',{align:'right'})]);
        yy=table(['Space','Area'],rows,x+4,yy,[w*.68-4,w*.32-4],{size:10,detailSize:8.7,padding:4,lastTotal:true})+8;
        if(pkg.scopeNote)yy=paragraph(pkg.scopeNote,x+8,yy,w-16,{size:9,color:MUTED});packageBottom=Math.max(packageBottom,yy);
      }
      cy=packageBottom+10;
    }
    cy=paragraph('Individual current sizes are reported for typical grade classrooms. Dimensions and area changes for those rooms are repeated in the room directory. Current measurements for other individual rooms were not provided.',MARGIN,cy,WIDTH-2*MARGIN,{size:9.5,color:MUTED});
    invariant(cy<=BOTTOM, 'Current and proposed comparison content exceeds its page.');
  }

  for(const building of specs.buildings) for(const floor of building.floors) {
    const floorRooms=specs.rooms.filter(room=>room.buildingId===building.id&&Number(room.floor)===Number(floor.floor));
    const parts=Math.ceil(floorRooms.length/15), chunkSize=Math.ceil(floorRooms.length/parts);
    for(let index=0;index<parts;index++) {
      const partRooms=floorRooms.slice(index*chunkSize,(index+1)*chunkSize);
      const title=`${building.name} · ${floorName(floor.floor)}`+(parts>1?` · ${index+1} of ${parts}`:'');
      await pause(`Composing ${title}…`);
      page(title,{type:'building-specifications',section:'room-directory',building_id:building.id,floor:floor.floor,room_ids:partRooms.map(r=>r.id)},'OLR CAMPUS · LIST');
      let dy=paragraph('Room directory',MARGIN,68,600,{size:15,bold:true,color:BLUE});
      text(`${fmt(floor.roomCount)} floor space${floor.roomCount===1?'':'s'} · ${sf(floor.netRoomSf)} net room area · ${sf(floor.grossSf)} gross floor area`,WIDTH-MARGIN,71,{size:10.5,color:MUTED,align:'right'});
      dy=paragraph('Dimensions are east-west × north-south in campus orientation. "Overall" gives the bounding dimensions of an irregular or inset room; multiplying them need not give its net area.',MARGIN,dy,WIDTH-2*MARGIN,{size:10,color:MUTED,gap:12});
      const rows=partRooms.map(room=>{
        const c=room.currentComparison;roomIds.push(room.id);
        return [cell(room.name,'',{bold:true}),categories.get(room.categoryId)?.name||room.categoryId,dimensions(room.dimensions),cell(sf(room.areaSf),'',{align:'right'}),...(specs.comparison?[c?cell(dimensions(c.dimensions),sf(c.currentAreaSf)):'Not provided',c?cell(`${signed(c.differenceSf)} SF`,`${signed(c.differencePercent)}%`,{align:'right'}):'-']:[]),fixtureText(room.fixtures)];
      });
      const fixtures=partRooms.reduce((a,r)=>{for(const k of ['wc','urinal','sink'])a[k]+=r.fixtures?.[k]||0;return a;},{wc:0,urinal:0,sink:0});
      rows.push([`${partRooms.length} space${partRooms.length===1?'':'s'} on this page`,'','',cell(sf(partRooms.reduce((sum,r)=>sum+r.areaSf,0)),'',{align:'right'}),...(specs.comparison?['No current-campus total is inferred.','']:[]),fixtureText(fixtures)]);
      const headers=['Room / space','Category','Proposed dimensions','Proposed net area',...(specs.comparison?['Current dimensions / area','Area change']:[]),'Fixtures'];
      const widths=specs.comparison?[218,163,201,111,162,108,189]:[265,210,270,150,257];
      dy=table(headers,rows,MARGIN,dy,widths,{size:11,detailSize:9.5,padding:6,lastTotal:true,bottom:685})+14;
      dy=paragraph('Net area follows each room\'s interior outline. Dedicated storage is listed separately and counted once. Displayed areas are rounded; totals use the underlying geometry.',MARGIN,dy,WIDTH-2*MARGIN,{size:9.5,color:MUTED,gap:5});
      if(specs.comparison)dy=paragraph('Current grade-room sizes use the reported typical classroom dimensions. "Not provided" means no individual current-room comparison was supplied.',MARGIN,dy,WIDTH-2*MARGIN,{size:9.5,color:MUTED});
      invariant(dy<=BOTTOM, 'Room directory notes exceed their page.');
    }
  }
  invariant(roomIds.length===specs.rooms.length&&new Set(roomIds).size===specs.rooms.length&&specs.rooms.every(room=>roomIds.includes(room.id)), 'Every room must appear exactly once in the directory.');
  await pause('Finishing your PDF…');
  for(let i=1;i<=pages.length;i++){doc.setPage(i);text(`${i} / ${pages.length}`,WIDTH-MARGIN,764,{size:8.25,color:MUTED,align:'right'});}
  check(); const bytes=new Uint8Array(doc.output('arraybuffer')); check();
  invariant(bytes.length>1000, 'The generated PDF is empty.');
  return {bytes,filename,pageCount:pages.length,pages,roomIds};
}
