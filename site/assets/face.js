// Browser-side face engine: detection + 128-d descriptor with face-api.js (the same ResNet
// architecture as the dlib model used by the desktop app). Camera frames never leave the device.
window.FaceEngine = (function () {
  "use strict";
  const MODELS = "/models";
  const MATCH_THRESHOLD = 0.5; // euclidean distance; same person ≈ 0.2–0.45, strangers ≈ 0.7+
  const MIN_FACE_RATIO = 0.11; // face box height relative to the frame height, below = "too far"
  let loading = null;
  let backend = null;

  function load(onProgress) {
    if (!loading) {
      loading = (async () => {
        if (typeof faceapi === "undefined") throw new Error("Moteur facial introuvable (vendor/face-api.js).");
        onProgress && onProgress("Chargement du moteur facial (7 Mo, une seule fois)…");
        try { await faceapi.tf.setBackend("webgl"); } catch (_) { await faceapi.tf.setBackend("cpu"); }
        await faceapi.tf.ready();
        backend = faceapi.tf.getBackend();
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
        ]);
      })().catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  async function describe(video, options) {
    const single = Boolean(options && options.single);
    await load(options && options.onProgress);
    if (!video.videoWidth) return { status: "no_face", reason: "none" };
    const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
    const faces = await faceapi.detectAllFaces(video, detector).withFaceLandmarks(true).withFaceDescriptors();
    if (!faces.length) return { status: "no_face", reason: "none" };
    if (single && faces.length > 1) return { status: "multi_face" };
    const best = faces.reduce((a, b) => (b.detection.box.area > a.detection.box.area ? b : a));
    if (best.detection.box.height < video.videoHeight * MIN_FACE_RATIO) return { status: "no_face", reason: "far" };
    return { status: "ok", descriptor: Array.from(best.descriptor), box: best.detection.box };
  }

  function distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    return Math.sqrt(sum);
  }

  function match(descriptor, known) {
    let best = null;
    for (const person of known) {
      const d = distance(descriptor, person.d);
      if (!best || d < best.distance) best = { member: person, distance: d };
    }
    return best && best.distance <= MATCH_THRESHOLD ? best : null;
  }

  return { load, describe, distance, match, threshold: MATCH_THRESHOLD, backend: () => backend };
})();
