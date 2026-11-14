/** Bounded, shared question protocol. Invalid data is rejected, never invented. */
export function normalizeQuestions(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 10) throw new Error('问题最多 10 项');
  const ids = new Set();
  const text = (value, max, required = false) => {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error('问题字段无效');
    return value.trim();
  };
  return raw.map(q => {
    if (!q || typeof q !== 'object') throw new Error('问题格式无效');
    const id = text(q.id, 100, true);
    if (ids.has(id)) throw new Error('问题编号重复');
    ids.add(id);
    const options = q.options ?? [];
    if (!Array.isArray(options) || options.length > 20) throw new Error('选项最多 20 项');
    const labels = new Set();
    return { id, question: text(q.question, 2000, true), header: text(q.header, 100), detail: text(q.detail, 4000), multiSelect: q.multiSelect === true,
      options: options.map(o => {
        const label = text(o?.label, 300, true);
        if (labels.has(label)) throw new Error('选项重复');
        labels.add(label);
        return { label, description: text(o.description, 1000) };
      }) };
  });
}

export function validateQuestionAnswer(raw, questions) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = null; }
    if ((value === null || typeof value !== 'object') && questions.length === 1 && raw.trim()) value = { answers: [{ id: questions[0].id, selected: [], custom: raw.trim() }] };
  }
  if (!value || !Array.isArray(value.answers) || value.answers.length !== questions.length) throw new Error('请回答所有问题');
  const seen = new Set();
  const answers = value.answers.map(a => {
    const q = questions.find(q => q.id === a?.id);
    if (!q || seen.has(a.id)) throw new Error('回答编号无效或重复');
    seen.add(a.id);
    const selected = a.selected ?? [];
    const custom = a.custom === undefined ? '' : a.custom;
    if (!Array.isArray(selected) || selected.some(s => typeof s !== 'string' || !q.options.some(o => o.label === s)) || new Set(selected).size !== selected.length) throw new Error('请选择有效选项');
    if (!q.multiSelect && selected.length > 1) throw new Error('该问题只能单选');
    if (typeof custom !== 'string' || custom.length > 2000 || (!selected.length && !custom.trim())) throw new Error('请填写有效回答');
    return { id: q.id, selected, ...(custom.trim() ? { custom: custom.trim() } : {}) };
  });
  return { answers: questions.map(q => answers.find(a => a.id === q.id)) };
}
