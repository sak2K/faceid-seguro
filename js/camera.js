/** Controle da câmera com tratamento de erros amigável. */

export class CameraError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

export function describeCameraError(err) {
  if (err instanceof CameraError) return err.message;
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Permissão para usar a câmera foi negada. Clique no ícone de câmera/cadeado na barra de endereço, permita o acesso e tente novamente. No Windows 11, verifique também Configurações > Privacidade e segurança > Câmera.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Nenhuma câmera foi encontrada. Conecte uma webcam e tente novamente.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'A câmera está sendo usada por outro aplicativo (ex.: Teams, Zoom, Câmera do Windows) ou falhou ao iniciar. Feche-o e tente novamente.';
    case 'OverconstrainedError':
      return 'A câmera selecionada não suporta a configuração solicitada. Escolha outra câmera.';
    case 'SecurityError':
      return 'O acesso à câmera foi bloqueado por política de segurança do navegador. Abra o sistema por http://localhost ou HTTPS.';
    default:
      return `Não foi possível acessar a câmera: ${err?.message || 'erro desconhecido'}.`;
  }
}

export class Camera {
  constructor() {
    this.stream = null;
    this.video = null;
  }

  static checkSupport() {
    if (!globalThis.isSecureContext) {
      throw new CameraError('A câmera só funciona em contexto seguro. Abra o sistema por http://localhost (npm start) ou por HTTPS.', 'insecure');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('Este navegador não suporta acesso à câmera. Use uma versão recente do Edge, Chrome ou Firefox.', 'unsupported');
    }
  }

  get active() {
    return Boolean(this.stream?.getVideoTracks().some((t) => t.readyState === 'live'));
  }

  async start(video, deviceId) {
    Camera.checkSupport();
    this.stop();
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else {
        throw err;
      }
    }
    this.stream = stream;
    this.video = video;
    video.srcObject = stream;
    await new Promise((resolve, reject) => {
      if (video.readyState >= 1) return resolve();
      const t = setTimeout(() => reject(new CameraError('A câmera não respondeu a tempo.', 'timeout')), 10_000);
      video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
    });
    await video.play();
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => this.onEnded?.();
    });
    return stream.getVideoTracks()[0]?.getSettings?.().deviceId || null;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
  }

  static async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }
}
