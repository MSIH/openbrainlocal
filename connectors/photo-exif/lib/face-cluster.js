// Pure, IO-free face clustering: group face descriptors into anonymous clusters by
// nearest-centroid within a Euclidean threshold. No ML, no network, no disk — so it's unit
// testable directly and the face worker owns all IO. Descriptors never leave the connector
// (doc 04 §11: core rejects connector-supplied embeddings); only human-assigned names ever go
// on the wire, as `pictured` hints.

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// Assign a descriptor to the nearest existing cluster within `threshold`, else start a new one.
// A match updates that cluster's centroid as a running mean and increments its count. Mutates
// `clusters` in place and returns the assigned cluster id (ids are dense positive integers).
export function assignCluster(descriptor, clusters, threshold) {
  let best = null;
  let bestDist = Infinity;
  for (const c of clusters) {
    const dist = euclideanDistance(descriptor, c.centroid);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (best && bestDist <= threshold) {
    best.centroid = best.centroid.map((v, i) => (v * best.count + descriptor[i]) / (best.count + 1));
    best.count += 1;
    return best.id;
  }
  const id = clusters.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  clusters.push({ id, centroid: [...descriptor], count: 1, label: null, sample: null });
  return id;
}

// Serialization helpers for the clusters file. `version` bumps whenever a label changes so the
// scan pass can tell when a previously-ingested photo needs re-emitting.
export function parseClustersFile(text) {
  try {
    const o = JSON.parse(text);
    return { version: o.version ?? 0, clusters: Array.isArray(o.clusters) ? o.clusters : [] };
  } catch {
    return { version: 0, clusters: [] };
  }
}

export function serializeClustersFile(version, clusters) {
  return JSON.stringify({ version, clusters });
}
