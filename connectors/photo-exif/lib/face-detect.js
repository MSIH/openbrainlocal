// Local, offline face detection. The heavy ML stack (@vladmandic/face-api + @tensorflow/tfjs-node
// + canvas) is loaded via DYNAMIC import only when a real detection actually runs, so importing
// this module (or the face worker) costs nothing and needs none of those packages present unless
// you actually scan — and the test suite injects a fixture detector instead (below), never
// touching ML. Models load once from FACE_MODELS_PATH (one-time download; fully offline after).
import { readFileSync } from 'node:fs';

// Test seam: PHOTO_EXIF_FACE_FIXTURE points at a JSON file mapping relPath -> an array of faces,
// each face either a bare descriptor array or { box, descriptor }. When set, detection returns
// those instead of loading any ML model — this is how test.mjs exercises the full scan/label/
// ingest pipeline deterministically with no models and no native dependencies.
export function fixtureDetector(fixturePath) {
  const map = JSON.parse(readFileSync(fixturePath, 'utf8'));
  return async function detectFaces(_absPath, relPath) {
    const faces = map[relPath] ?? [];
    return faces.map((f) => (Array.isArray(f)
      ? { box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: f }
      : { box: f.box ?? { x: 0, y: 0, width: 1, height: 1 }, descriptor: f.descriptor }));
  };
}

// Real detector: lazy-load the ML stack, load models once, return detectFaces(absPath). Unverified
// in this repo's CI (no models/GPU here) — same posture as the VLM caption path; behavior is
// covered by the fixture detector, model quality/latency is a manual, on-device concern.
export async function loadModelDetector(modelsPath) {
  if (!modelsPath) throw new Error('FACE_MODELS_PATH not set (required for face detection)');
  const faceapi = await import('@vladmandic/face-api');
  const { Canvas, Image, ImageData, loadImage } = await import('canvas');
  await import('@tensorflow/tfjs-node'); // registers the native backend as a side effect
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);
  return async function detectFaces(absPath) {
    const img = await loadImage(absPath);
    const results = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
    return results.map((r) => ({ box: r.detection.box, descriptor: Array.from(r.descriptor) }));
  };
}

// Pick the detector: the fixture seam (tests) when set, otherwise the real model detector.
export async function resolveDetector({ modelsPath, fixturePath }) {
  return fixturePath ? fixtureDetector(fixturePath) : loadModelDetector(modelsPath);
}
