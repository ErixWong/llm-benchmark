const SIMPLE_PROMPT_TEMPLATES = [
  '请写一篇约 700-900 字的中文短文，主题是「人工智能发展历程」，需要包含关键里程碑和未来展望，并控制在 1000 token 以内。',
  '请用中文写一篇结构清晰的简短综述，介绍人工智能的主要发展阶段、代表性技术突破及未来趋势，全文尽量控制在 1000 token 以内。',
  '请撰写一篇中文说明文，概述人工智能从早期符号主义到大模型时代的发展路径，并分析未来应用方向，输出控制在 1000 token 以内。',
  '请用中文完成一篇简洁文章，主题为人工智能技术演进史，要求涵盖代表事件、产业变化与未来挑战，限制在 1000 token 以内。',
  '请写一篇中文科普短文，介绍人工智能的重要历史节点、深度学习兴起以及未来可能的发展，全文控制在 1000 token 以内。'
];

const SIMPLE_PROMPT_SUFFIXES = [
  '请使用小标题分段。',
  '请控制段落数量在 4 到 6 段之间。',
  '请尽量避免空泛表述，优先给出具体里程碑。',
  '请在结尾加入 2-3 句简短总结。',
  '请使用偏正式但易读的中文表达。'
];

function createSimplePromptVariant() {
  const template = SIMPLE_PROMPT_TEMPLATES[Math.floor(Math.random() * SIMPLE_PROMPT_TEMPLATES.length)];
  const suffix = SIMPLE_PROMPT_SUFFIXES[Math.floor(Math.random() * SIMPLE_PROMPT_SUFFIXES.length)];
  return `${template} ${suffix}`;
}

export {
  SIMPLE_PROMPT_TEMPLATES,
  SIMPLE_PROMPT_SUFFIXES,
  createSimplePromptVariant
};
