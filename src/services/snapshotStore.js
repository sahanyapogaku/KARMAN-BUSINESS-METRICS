import { BlobServiceClient } from "@azure/storage-blob";

const CONTAINER_NAME = "snapshots";
const CACHE_MS = 60_000;
const caches = {};

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

// Reads a metric snapshot JSON blob written by refresh/snapshot-refresh.mjs
// (which runs on-prem, where Teamcenter/Manufacturo/Jira are actually reachable).
// Used instead of live DB/API calls when DATA_SOURCE=snapshot (i.e. in Azure).
export async function loadSnapshot(blobName) {
  const now = Date.now();
  const cached = caches[blobName];
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.data;

  const connectionString = process.env.STORAGE_CONNECTION_STRING;
  if (!connectionString) throw new Error("STORAGE_CONNECTION_STRING is not configured");

  const blobService = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobService.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobName);

  const download = await blobClient.download();
  const text = await streamToString(download.readableStreamBody);
  const data = JSON.parse(text);

  caches[blobName] = { data, fetchedAt: now };
  return data;
}

export async function saveSnapshot(blobName, data) {
  const connectionString = process.env.STORAGE_CONNECTION_STRING;
  if (!connectionString) throw new Error("STORAGE_CONNECTION_STRING is not configured");

  const blobService = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobService.getContainerClient(CONTAINER_NAME);
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const body = JSON.stringify(data);
  await blockBlobClient.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}
