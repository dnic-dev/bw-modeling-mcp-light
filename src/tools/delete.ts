import { BwClient, MEDIA_TYPES } from '../bw-client.js';

function parseAtomTitles(xml: string): string[] {
  return [...xml.matchAll(/<atom:title[^>]*>([^<]+)<\/atom:title>/g)].map(m => m[1]);
}

export async function bwDelete(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const typeLower = objectType.toLowerCase();
  const mediaType = MEDIA_TYPES[typeLower] ?? 'application/xml';

  // 1. Lock — uses /m before ?action=lock (delete-specific lock URL)
  const lockHandle = await client.lockForDelete(typeLower, objectName, mediaType);

  // 2. DELETE
  const deleteResult = await client.delete(typeLower, objectName, lockHandle, mediaType);

  // 3. Unlock — no /m (same as normal unlock)
  await client.unlock(typeLower, objectName);

  // 4. Parse atom feed response
  const messages = parseAtomTitles(deleteResult);

  return JSON.stringify({
    success: true,
    object_type: objectType.toUpperCase(),
    object_name: objectName.toUpperCase(),
    messages,
  });
}
