'use strict';
// Things the chat window can build from an answer (mind maps, charts, drawings, slideshow
// videos) and two working styles (finance, marketing). The matching instruction joins the
// system prompt only for a request that needs it, so ordinary questions pay no extra tokens.

// Unicode-aware word boundaries (JS \b is ASCII-only and breaks on Vietnamese letters).
const W = (alts) => new RegExp('(?<![\\p{L}\\p{N}_])(?:' + alts + ')(?![\\p{L}\\p{N}_])', 'iu');

const RE = {
  mindmap: W('mind ?maps?|sơ đồ tư duy|bản đồ tư duy|sơ đồ cây'),
  chart: W('biểu đồ|đồ thị|charts?|graphs?|plot|trực quan hoá|trực quan hóa|visuali[sz]e'),
  draw: W('vẽ|minh hoạ|minh họa|hình vẽ|dựng hình|tạo (?:hình|ảnh)|sơ đồ (?:quy trình|tổ chức|khối)|lưu đồ|flowchart|infographic|logo|icon|poster|banner|draw|illustrat\\w*|diagram|sketch|(?:picture|image) of'),
  drawStrong: W('minh hoạ|minh họa|hình vẽ|dựng hình|tạo (?:hình|ảnh)|infographic|logo|icon|poster|banner|illustrat\\w*|(?:picture|image) of'),
  video: W('video|clip|slideshow|trình chiếu|storyboard'),
  finance: W('tài chính|doanh thu|lợi nhuận|chi phí|dòng tiền|ngân sách|kết quả kinh doanh|bảng cân đối|điểm hoà vốn|điểm hòa vốn|biên lợi nhuận|định giá|ROI|NPV|IRR|EBITDA|P&L|cash ?flow|revenue|profit|budget|break-?even|financial|valuation'),
  marketing: W('marketing|MKT|quảng cáo|chiến dịch|thương hiệu|khách hàng mục tiêu|kế hoạch nội dung|content plan|SEO|fanpage|tiktok|campaign|branding|go-to-market|funnel|persona'),
};

const TEXT = {
  mindmap: 'MIND MAP: this app draws mind maps. When one is asked for, output a fenced block with language `mindmap` holding an indented outline: the first line is the central topic, children are indented 2 spaces per level, one short phrase per line, at most 4 levels. Put any explanation outside the block.',
  chart: 'CHART: this app draws charts. To show numbers, output a fenced block with language `chart` holding JSON only: {"type":"bar|line|pie","title":"…","unit":"…","labels":["…"],"series":[{"name":"…","data":[numbers]}]}. Use only figures the user gave or that you computed from them, and show the calculation in the text.',
  draw: 'DRAWING: this app shows drawings. To draw a diagram, icon, illustration or infographic, output a fenced block with language `svg` holding one complete, self-contained <svg> with a viewBox: no scripts, no external images or fonts.',
  image: 'For a photo-realistic or painted picture instead, output a fenced block with language `image` holding one detailed prompt in English; the app generates the picture.',
  video: 'VIDEO: this app builds a slideshow video. Output a fenced block with language `video` holding JSON only: {"title":"…","scenes":[{"title":"…","text":"one or two short sentences","emoji":"one emoji","color":"#rrggbb","seconds":4}]} with 4 to 10 scenes that tell the story in order.',
  finance: 'FINANCE: state your assumptions first; show formulas and step-by-step arithmetic; label every estimate as an estimate; never invent a figure that was not provided; present results in tables; end with the main risks and which data would change the conclusion.',
  marketing: 'MARKETING: start from the audience and positioning, then message, channels, budget split, calendar and KPIs in tables; mark every number that is an assumption; give 2 or 3 concrete copy examples in the user\'s language.',
};

function detect(text) {
  const t = String(text || '');
  const ids = ['mindmap', 'chart', 'draw', 'video', 'finance', 'marketing'].filter((id) => RE[id].test(t));
  // "vẽ biểu đồ", "vẽ mindmap": the verb alone does not ask for a free drawing.
  if ((ids.includes('mindmap') || ids.includes('chart')) && ids.includes('draw') && !RE.drawStrong.test(t)) ids.splice(ids.indexOf('draw'), 1);
  return ids;
}

// opts.image: an account that can generate pictures is set up.
function hints(text, opts) {
  const ids = detect(text);
  if (!ids.length) return '';
  const parts = [];
  for (const id of ids) parts.push(id === 'draw' && opts && opts.image ? TEXT.draw + ' ' + TEXT.image : TEXT[id]);
  if (ids.includes('finance') && !ids.includes('chart')) parts.push(TEXT.chart);
  return parts.join('\n');
}

module.exports = { detect, hints, TEXT };
