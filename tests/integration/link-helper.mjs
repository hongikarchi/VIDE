// Link an open host document to the page's project the way the host plugin's Link does
// (SPEC-01.11), then wait for its first Sync to finish in the browser.
export async function linkOpenDocument(
  page,
  { host = 'rhino', instance, documentId },
  timeout = 90000,
) {
  const projectId = await page.locator('#project-picker').inputValue();
  const reply = await page.evaluate(
    async ({ projectId, body }) => {
      const response = await fetch(`/api/v1/projects/${projectId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { projectId, body: { host, instance, documentId } },
  );
  if (reply.status !== 201) throw new Error('Link failed: ' + JSON.stringify(reply));
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`.link-row[data-link-id="${id}"]`);
      return row && !/Sync 전|Sync 중/.test(row.textContent);
    },
    reply.body.id,
    { timeout },
  );
  return reply.body;
}
