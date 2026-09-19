export function materialPdfUrl(materialId, pageUrl = globalThis.location?.href ?? '') {
  const id = encodeURIComponent(materialId);
  return /^https?:/i.test(pageUrl) ? `http://material.localhost/pdf/${id}` : `material://pdf/${id}`;
}
