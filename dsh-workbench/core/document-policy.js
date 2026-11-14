/** A user confirms current bytes; viewing, generation and old receipts are not consent. */
export function assertCurrentDocument({latestId, documentId, currentHash, expectedHash}) {
  if (!latestId || latestId !== documentId) throw new Error('只能确认当前版本，请先打开最新一版');
  if (!/^[a-f0-9]{64}$/.test(currentHash || '') || expectedHash !== currentHash)
    throw new Error('这份内容已经变化，请重新阅读后再确认');
}
export function assertDocumentHashes(current, expected) {
  if (!expected || Object.keys(current).some(name => expected[name] !== current[name]))
    throw new Error('文档版本已变化，请刷新审阅后重新确认');
}
