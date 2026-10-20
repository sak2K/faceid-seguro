/**
 * Camada de reconhecimento facial usando @vladmandic/face-api (TensorFlow.js).
 * Todos os modelos são carregados da pasta local /models — nenhuma imagem sai do dispositivo.
 */
import * as faceapi from '../vendor/face-api/face-api.esm.js';

const MODEL_URL = './models';
let loaded = false;
let backend = null;

export async function loadModels(onProgress = () => {}) {
  if (loaded) return { backend };
  onProgress('Inicializando motor de IA…');
  for (const b of ['webgl', 'cpu']) {
    try {
      if (await faceapi.tf.setBackend(b)) {
        await faceapi.tf.ready();
        backend = b;
        break;
      }
    } catch { /* tenta o próximo */ }
  }
  if (!backend) throw new Error('Seu navegador não suporta o processamento necessário (WebGL). Atualize o navegador ou ative a aceleração de hardware.');

  const nets = [
    ['detector rápido', faceapi.nets.tinyFaceDetector],
    ['detector preciso', faceapi.nets.ssdMobilenetv1],
    ['pontos faciais', faceapi.nets.faceLandmark68Net],
    ['reconhecimento', faceapi.nets.faceRecognitionNet],
  ];
  for (const [i, [label, net]] of nets.entries()) {
    onProgress(`Carregando modelo de ${label} (${i + 1}/${nets.length})…`);
    try {
      await net.loadFromUri(MODEL_URL);
    } catch (err) {
      throw new Error(`Falha ao carregar o modelo de ${label}. Verifique se a pasta "models" existe e se o sistema foi aberto por um servidor local. (${err.message})`);
    }
  }
  loaded = true;
  return { backend };
}

function detectorOptions(mode) {
  return mode === 'accurate'
    ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
    : new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
}

/** Detecta todos os rostos com descritores (para reconhecimento em tempo real). */
export async function detectAll(input, mode = 'fast') {
  return faceapi.detectAllFaces(input, detectorOptions(mode)).withFaceLandmarks().withFaceDescriptors();
}

/** Apenas detecta rostos (sem descritores) — usado na pré-visualização do cadastro. */
export async function detectFaces(input) {
  return faceapi.detectAllFaces(input, detectorOptions('fast'));
}

/**
 * Detecta exatamente um rosto (para cadastro). Usa o detector preciso.
 * Lança erros com mensagens amigáveis.
 */
export async function detectSingle(input) {
  const results = await faceapi
    .detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  if (results.length === 0) throw new Error('Nenhum rosto encontrado. Melhore a iluminação e olhe para a câmera.');
  if (results.length > 1) throw new Error(`Foram encontrados ${results.length} rostos. Deve haver apenas uma pessoa na imagem.`);
  const [r] = results;
  const { width, height } = r.detection.box;
  if (width < 80 || height < 80) throw new Error('O rosto está muito pequeno/distante. Aproxime-se da câmera.');
  if (r.detection.score < 0.75) throw new Error('A imagem do rosto não está nítida o suficiente. Tente novamente.');
  return r;
}

/** Cria o comparador a partir das pessoas cadastradas. Retorna null se não houver ninguém. */
export function buildMatcher(people, threshold) {
  const labeled = people
    .filter((p) => Array.isArray(p.descriptors) && p.descriptors.length)
    .map((p) => new faceapi.LabeledFaceDescriptors(p.id, p.descriptors.map((d) => Float32Array.from(d))));
  return labeled.length ? new faceapi.FaceMatcher(labeled, threshold) : null;
}

/** Distância euclidiana -> confiança aproximada (0 a 100%). */
export function distanceToConfidence(distance, threshold) {
  const c = 1 - distance / (threshold * 2);
  return Math.round(Math.max(0, Math.min(1, c)) * 100);
}

export function euclideanDistance(a, b) {
  return faceapi.euclideanDistance(a, b);
}

/** Recorta o rosto (com margem) e devolve um JPEG pequeno em data URL. */
export function cropFace(source, box, size = 200) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const margin = 0.35;
  const side = Math.max(box.width, box.height) * (1 + margin * 2);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const sx = Math.max(0, Math.min(sw - side, cx - side / 2));
  const sy = Math.max(0, Math.min(sh - side, cy - side / 2));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, sx, sy, Math.min(side, sw), Math.min(side, sh), 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}
