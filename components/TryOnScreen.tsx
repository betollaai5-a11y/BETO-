
import React, { useState, useRef, useEffect } from 'react';
import { Lens } from '../types';
import { LENSES } from '../constants';
import { 
  mapLandmark, 
  getDistance, 
  lerp,
  LEFT_IRIS_INDICES, 
  RIGHT_IRIS_INDICES,
  LEFT_BLINK_INDICES,
  RIGHT_BLINK_INDICES
} from './ar-utils';

// --- CONFIGURATION ---
const SMOOTHING_FACTOR = 0.5; // Higher = faster tracking, Lower = smoother.
const LENS_OPACITY = 0.75; // Visibility of the lens. A balanced value for a vibrant yet realistic color.
const BLINK_THRESHOLD = 0.015; // Normalized distance threshold to detect blink

interface TryOnScreenProps {
  lens: Lens;
  onBack: () => void;
}

const TryOnScreen: React.FC<TryOnScreenProps> = ({ lens: initialLens, onBack }) => {
  const [currentLens, setCurrentLens] = useState<Lens>(initialLens);
  const currentLensRef = useRef(initialLens); // Ref to hold the latest lens for the animation loop
  const [cameraState, setCameraState] = useState<'LOADING' | 'READY' | 'ERROR' | 'PERMISSION_DENIED'>('LOADING');
  const [trackingStatus, setTrackingStatus] = useState<'SEARCHING' | 'LOCKED'>('SEARCHING');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [sizeAdjustment, setSizeAdjustment] = useState(1.0);
  const [showInstruction, setShowInstruction] = useState(false);

  // Keep the ref in sync with the state to avoid stale closures in the render loop
  useEffect(() => {
    currentLensRef.current = currentLens;
  }, [currentLens]);

  // --- REFS ---
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Logic Refs
  const requestRef = useRef<number>(0);
  const faceMeshRef = useRef<any>(null);
  const cameraUtilsRef = useRef<any>(null);
  const activeRef = useRef(true);
  const landmarksRef = useRef<any>(null);

  // Smoothing State
  const trackingState = useRef({
    left: { x: 0, y: 0, r: 20, visible: false },
    right: { x: 0, y: 0, r: 20, visible: false }
  });
  
  const handleSizeChange = (delta: number) => {
    setSizeAdjustment(prev => Math.max(0.8, Math.min(1.3, prev + delta)));
  };

  // --- LENS DRAWING HELPER ---
  const drawCircularLens = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, hexColor: string) => {
    const parseHex = (hex: string) => {
        hex = hex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16) || 0;
        const g = parseInt(hex.substring(2, 4), 16) || 0;
        const b = parseInt(hex.substring(4, 6), 16) || 0;
        return { r, g, b };
    };

    const baseColor = parseHex(hexColor);
    
    // Save the default state
    ctx.save();
    
    // Set blend mode for realistic color mixing with the eye
    ctx.globalCompositeOperation = 'overlay';

    // 1. Outer Limbal Ring (for definition and depth)
    const ringR = Math.max(0, baseColor.r - 60);
    const ringG = Math.max(0, baseColor.g - 60);
    const ringB = Math.max(0, baseColor.b - 60);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${ringR}, ${ringG}, ${ringB}, 0.5)`;
    ctx.lineWidth = r * 0.2; // Ring is 20% of the radius thick
    ctx.stroke();

    // 2. Main Lens Color (with a radial gradient for a natural look)
    const lighterR = Math.min(255, baseColor.r + 50);
    const lighterG = Math.min(255, baseColor.g + 50);
    const lighterB = Math.min(255, baseColor.b + 50);
    
    const gradient = ctx.createRadialGradient(x, y, r * 0.1, x, y, r * 0.9);
    gradient.addColorStop(0, `rgba(${lighterR}, ${lighterG}, ${lighterB}, 0.9)`);
    gradient.addColorStop(0.8, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 1)`);
    gradient.addColorStop(1, `rgba(${ringR}, ${ringG}, ${ringB}, 1)`);

    ctx.beginPath();
    ctx.arc(x, y, r * 0.9, 0, Math.PI * 2); // Slightly smaller to fit inside the ring
    ctx.fillStyle = gradient;
    ctx.fill();

    // Restore default blend mode before drawing pupil and glare
    ctx.restore();
    ctx.save();
    
    // 3. Pupil Hole (soft gradient for realism)
    const pupilGradient = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 0.45);
    pupilGradient.addColorStop(0, 'rgba(0, 0, 0, 0.8)'); // Darker center to blend with pupil
    pupilGradient.addColorStop(1, 'rgba(0, 0, 0, 0)'); // Fades out for a soft edge
    ctx.fillStyle = pupilGradient;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.fill();

    // 4. Subtle Glare (for realism)
    const glareGradient = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 0, x - r*0.4, y - r*0.4, r * 0.6);
    glareGradient.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
    glareGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glareGradient;
    ctx.fill();

    ctx.restore();
  };

  // --- INITIALIZATION ---
  useEffect(() => {
    activeRef.current = true;

    const startApp = async () => {
      if (!window.FaceMesh || !videoRef.current || !canvasRef.current || !containerRef.current) {
        setCameraState('ERROR');
        return;
      }
      
      const canvas = canvasRef.current;
      canvas.width = containerRef.current.clientWidth;
      canvas.height = containerRef.current.clientHeight;

      const faceMesh = new window.FaceMesh({ 
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` 
      });
      
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
      });

      faceMesh.onResults((results: any) => {
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
          landmarksRef.current = results.multiFaceLandmarks[0];
          setTrackingStatus('LOCKED');
        } else {
          landmarksRef.current = null;
          setTrackingStatus('SEARCHING');
        }
      });
      faceMeshRef.current = faceMesh;

      const camera = new window.Camera(videoRef.current, {
        onFrame: async () => {
          if (activeRef.current && videoRef.current && faceMeshRef.current) {
            await faceMeshRef.current.send({ image: videoRef.current });
          }
        },
        width: 1280,
        height: 720,
        facingMode: 'user'
      });

      try {
        await camera.start();
        setCameraState('READY');
        startRenderLoop();
      } catch (e: any) {
        console.error("Camera Error:", e);
        if (e.name === 'NotAllowedError' || e.message?.includes('Permission denied')) {
          setCameraState('PERMISSION_DENIED');
        } else {
          setCameraState('ERROR');
        }
      }
      cameraUtilsRef.current = camera;
    };

    startApp();

    return () => {
      activeRef.current = false;
      cancelAnimationFrame(requestRef.current);
      if (cameraUtilsRef.current) cameraUtilsRef.current.stop();
      if (faceMeshRef.current) faceMeshRef.current.close();
    };
  }, []);

    // --- CAPTURE LOGIC ---
  useEffect(() => {
    if (countdown === null) return;
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    } else {
      captureFrame();
      setCountdown(null);
    }
  }, [countdown]);

  const startCaptureSequence = () => {
    if (countdown !== null || showInstruction) return;
    setShowInstruction(true);
  };
  
  const beginCountdown = () => {
    setShowInstruction(false);
    setCountdown(3);
  };

  const captureFrame = () => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/jpeg', 0.95);
    addWatermark(dataUrl, currentLens.name).then(final => setGeneratedImage(final));
  };

  const addWatermark = (imgUrl: string, lensName: string): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(imgUrl);

        ctx.drawImage(img, 0, 0);

        const gradient = ctx.createLinearGradient(0, canvas.height - 300, 0, canvas.height);
        gradient.addColorStop(0, "transparent");
        gradient.addColorStop(1, "rgba(0,0,0,0.8)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, canvas.height - 300, canvas.width, 300);

        const centerX = canvas.width / 2;
        ctx.shadowColor = "rgba(212, 175, 55, 0.5)";
        ctx.shadowBlur = 15;
        ctx.font = "900 60px 'Playfair Display'"; 
        ctx.fillStyle = "#D4AF37"; 
        ctx.textAlign = "center";
        ctx.fillText("BETO", centerX, canvas.height - 140);
        
        ctx.shadowBlur = 0;
        ctx.font = "500 24px 'Manrope'";
        ctx.fillStyle = "#FFFFFF";
        ctx.letterSpacing = "3px";
        ctx.fillText(lensName.toUpperCase(), centerX, canvas.height - 90);

        ctx.font = "300 18px 'Manrope'";
        ctx.fillStyle = "#D4AF37";
        ctx.letterSpacing = "0px";
        ctx.fillText("نتيجة لون العدسة على العين مطابقة بنسبة ٨٥٪ إلى ٩٠٪", centerX, canvas.height - 55);
        
        resolve(canvas.toDataURL('image/jpeg', 0.90));
      };
      img.onerror = () => resolve(imgUrl);
      img.src = imgUrl;
    });
  };

  const handleShare = async () => {
    if (!generatedImage) return;

    const dataURLtoBlob = (dataurl: string): Blob | null => {
      try {
        const arr = dataurl.split(',');
        const mimeMatch = arr[0].match(/:(.*?);/);
        if (!mimeMatch) return null;
        const mime = mimeMatch[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
          u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
      } catch (e) {
        console.error("Error converting data URL to Blob:", e);
        return null;
      }
    };

    try {
      const blob = dataURLtoBlob(generatedImage);
      if (!blob) {
        console.error("Failed to create blob from image data.");
        return;
      }
      
      const file = new File([blob], 'BETO_Look.jpg', { type: 'image/jpeg' });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'My BETO Lens Look',
          text: 'Check out my new look with BETO lenses! #BETOLenses',
        });
      } else {
        const link = document.createElement('a');
        link.href = generatedImage;
        link.download = 'BETO_Look.jpg';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (e) {
      console.log("Sharing failed:", e);
      const link = document.createElement('a');
      link.href = generatedImage;
      link.download = 'BETO_Look.jpg';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // --- RENDER LOOP ---
  const drawLenses = (ctx: CanvasRenderingContext2D, landmarks: any[], canvasW: number, canvasH: number) => {
      const vW = videoRef.current!.videoWidth;
      const vH = videoRef.current!.videoHeight;
      if (!vW || !vH) return;

      const processEye = (eyeState: any, irisIndices: typeof LEFT_IRIS_INDICES, blinkIndices: number[]) => {
          const topLm = landmarks[irisIndices.top];
          const bottomLm = landmarks[irisIndices.bottom];
          const leftLm = landmarks[irisIndices.left];
          const rightLm = landmarks[irisIndices.right];
          const blinkTopLm = landmarks[blinkIndices[0]];
          const blinkBottomLm = landmarks[blinkIndices[1]];
          const centerLm = landmarks[irisIndices.center];

          if (!topLm || !bottomLm || !leftLm || !rightLm || !blinkTopLm || !blinkBottomLm || !centerLm) {
              eyeState.visible = false;
              return;
          }
          
          const blinkDist = getDistance(blinkTopLm, blinkBottomLm);
          if (blinkDist < BLINK_THRESHOLD) {
              eyeState.visible = false;
              return;
          }
          eyeState.visible = true;

          const centerPt = mapLandmark(centerLm, vW, vH, canvasW, canvasH);
          const topPt = mapLandmark(topLm, vW, vH, canvasW, canvasH);
          const bottomPt = mapLandmark(bottomLm, vW, vH, canvasW, canvasH);
          const leftPt = mapLandmark(leftLm, vW, vH, canvasW, canvasH);
          const rightPt = mapLandmark(rightLm, vW, vH, canvasW, canvasH);
          
          const horizontalDiameter = getDistance(leftPt, rightPt);
          const verticalDiameter = getDistance(topPt, bottomPt);
          const averageDiameter = (horizontalDiameter + verticalDiameter) / 2;
          
          const finalDiameter = averageDiameter * 1.15;

          eyeState.x = lerp(eyeState.x, centerPt.x, SMOOTHING_FACTOR);
          eyeState.y = lerp(eyeState.y, centerPt.y, SMOOTHING_FACTOR);
          eyeState.r = lerp(eyeState.r, finalDiameter * sizeAdjustment, SMOOTHING_FACTOR);

          if (eyeState.visible) {
             drawCircularLens(ctx, eyeState.x, eyeState.y, eyeState.r / 2, currentLensRef.current.color);
          }
      };

      ctx.globalAlpha = LENS_OPACITY;
      processEye(trackingState.current.right, RIGHT_IRIS_INDICES, RIGHT_BLINK_INDICES);
      processEye(trackingState.current.left, LEFT_IRIS_INDICES, LEFT_BLINK_INDICES);
      ctx.globalAlpha = 1.0;
  };

  const startRenderLoop = () => {
    const render = () => {
      if (!activeRef.current || !canvasRef.current || !videoRef.current || !containerRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const video = videoRef.current;
      if (!ctx || video.readyState < 2) {
          requestRef.current = requestAnimationFrame(render);
          return;
      }

      const canvasW = canvas.width = containerRef.current.clientWidth;
      const canvasH = canvas.height = containerRef.current.clientHeight;
      const vW = video.videoWidth;
      const vH = video.videoHeight;
      
      const videoAspect = vW / vH;
      const canvasAspect = canvasW / canvasH;
      let drawW, drawH, drawX, drawY;

      if (canvasAspect > videoAspect) {
        drawW = canvasW;
        drawH = canvasW / videoAspect;
        drawX = 0;
        drawY = (canvasH - drawH) / 2;
      } else {
        drawH = canvasH;
        drawW = canvasH * videoAspect;
        drawY = 0;
        drawX = (canvasW - drawW) / 2;
      }
      
      ctx.save();
      ctx.translate(canvasW, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, -drawX, drawY, drawW, drawH);
      ctx.restore();

      if (landmarksRef.current) {
        drawLenses(ctx, landmarksRef.current, canvasW, canvasH);
      }
      
      requestRef.current = requestAnimationFrame(render);
    };
    render();
  };

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col overflow-hidden">
      
      <div className="relative flex-1 bg-neutral-900 overflow-hidden" ref={containerRef}>
        <video ref={videoRef} autoPlay playsInline muted className="absolute opacity-0 pointer-events-none w-1 h-1" />
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block z-10" />

        {cameraState === 'LOADING' && (
           <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-black text-luxury-gold">
               <span className="material-symbols-outlined text-5xl animate-spin mb-4">settings_suggest</span>
               <p className="text-xs font-bold tracking-widest">INITIALIZING AI VISION...</p>
           </div>
        )}
        {cameraState === 'PERMISSION_DENIED' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-50 bg-luxury-black/95 text-center p-8 animate-in fade-in">
                <span className="material-symbols-outlined text-6xl text-red-500/80 mb-6">videocam_off</span>
                <h2 className="text-luxury-gold text-2xl font-serif font-bold mb-3">Camera Access Needed</h2>
                <p className="text-white/60 text-sm mb-8 leading-relaxed max-w-xs mx-auto">
                    BETO requires camera access. Please enable permissions and try again.
                </p>
                <button onClick={() => window.location.reload()} className="gold-gradient text-luxury-black font-bold py-4 px-10 rounded-xl uppercase tracking-widest shadow-lg hover:scale-105 transition-transform">Try Again</button>
                <button onClick={onBack} className="mt-6 text-white/40 text-xs font-bold uppercase tracking-widest hover:text-white">Return Home</button>
            </div>
        )}
        {cameraState === 'READY' && trackingStatus === 'SEARCHING' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                <div className="border-2 border-white/20 w-48 h-64 rounded-[50%] animate-pulse relative">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 -mt-8 text-white/50 text-xs font-bold uppercase tracking-widest">Position Face</div>
                </div>
            </div>
        )}
        {showInstruction && (
            <div className="absolute inset-0 z-[55] flex flex-col items-center justify-center bg-luxury-black/90 backdrop-blur-md p-8 text-center animate-in fade-in">
                <span className="material-symbols-outlined text-7xl text-luxury-gold mb-6">
                    center_focus_strong
                </span>
                <h2 className="text-white text-2xl font-serif font-bold mb-4">
                    استعد لالتقاط الصورة!
                </h2>
                <p className="text-white/70 text-base leading-relaxed max-w-xs mx-auto mb-8">
                    يرجى تثبيت الوجه وتوسيع العينين للحصول على أفضل نتيجة.
                </p>
                <button 
                    onClick={beginCountdown}
                    className="gold-gradient text-luxury-black font-bold py-4 px-12 rounded-xl uppercase tracking-widest shadow-lg shadow-luxury-gold/20 hover:scale-105 transition-transform"
                >
                    موافق، لنبدأ
                </button>
            </div>
        )}
        {countdown !== null && countdown > 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/20 backdrop-blur-[2px]">
            <div className="text-[120px] font-black text-white drop-shadow-[0_0_20px_rgba(212,175,55,0.8)] animate-bounce font-serif">{countdown}</div>
          </div>
        )}
      </div>

      <div className="absolute top-0 left-0 right-0 p-4 z-40 flex justify-between items-center bg-gradient-to-b from-black/80 to-transparent h-24 pointer-events-none">
        <button onClick={onBack} className="pointer-events-auto w-10 h-10 rounded-full bg-white/10 backdrop-blur border border-white/20 flex items-center justify-center text-white"><span className="material-symbols-outlined">arrow_back</span></button>
        <div className="text-center">
            <h3 className="text-luxury-gold font-serif font-bold tracking-widest text-lg drop-shadow-md">{currentLens.name}</h3>
            <div className="flex items-center justify-center gap-2">
                <div className={`w-2 h-2 rounded-full ${trackingStatus === 'LOCKED' ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}></div>
                <p className="text-white/50 text-[10px] uppercase">{trackingStatus === 'LOCKED' ? 'LIVE TRACKING' : 'SEARCHING...'}</p>
            </div>
        </div>
        <div className="w-10 h-10"></div>
      </div>

      {/* --- Size Adjustment Controls --- */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-4">
        <button onClick={() => handleSizeChange(0.02)} className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-md border border-white/20 text-white text-xl font-bold flex items-center justify-center active:scale-95 transition-transform">+</button>
        <div className="w-1 h-8 bg-white/10 rounded-full">
            <div className="h-full bg-luxury-gold rounded-full" style={{transform: `scaleY(${(sizeAdjustment - 0.8) / (1.3 - 0.8)})`, transformOrigin: 'bottom'}}></div>
        </div>
        <button onClick={() => handleSizeChange(-0.02)} className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-md border border-white/20 text-white text-2xl font-bold flex items-center justify-center active:scale-95 transition-transform">-</button>
      </div>

      <div className="absolute bottom-36 left-0 right-0 z-40 flex justify-center pointer-events-none">
          <button onClick={startCaptureSequence} disabled={countdown !== null || showInstruction || trackingStatus !== 'LOCKED'} className="pointer-events-auto w-20 h-20 rounded-full border-[4px] border-white/30 bg-white/10 backdrop-blur-sm flex items-center justify-center relative active:scale-95 transition-all hover:bg-white/20 disabled:opacity-50 disabled:scale-100">
              <div className="w-16 h-16 bg-white rounded-full border-[3px] border-black shadow-lg flex items-center justify-center">
                 <span className="material-symbols-outlined text-black text-3xl">photo_camera</span>
              </div>
          </button>
      </div>

      <div className="bg-luxury-surface border-t border-white/10 p-5 z-40 relative">
          <div className="flex justify-between items-end mb-3">
             <p className="text-white/40 text-[10px] uppercase font-bold tracking-widest">COLLECTION: {currentLens.collection}</p>
             <p className="text-luxury-gold text-xs font-serif">{currentLens.name}</p>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
              {LENSES.map(l => (
                  <button key={l.id} onClick={() => setCurrentLens(l)} className={`w-14 h-14 shrink-0 rounded-full border-2 p-0.5 relative transition-all ${currentLens.id === l.id ? 'border-luxury-gold scale-110' : 'border-transparent opacity-50'}`}>
                      <div className="w-full h-full rounded-full overflow-hidden relative shadow-lg" style={{ backgroundColor: l.color }}>
                          <div className="absolute inset-0 bg-gradient-to-br from-white/30 via-transparent to-black/20"></div>
                      </div>
                  </button>
              ))}
          </div>
      </div>
      
      {generatedImage && (
        <div className="fixed inset-0 z-[60] bg-black/95 backdrop-blur-xl flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="w-full max-w-sm bg-luxury-surface rounded-[2rem] overflow-hidden shadow-2xl border border-luxury-gold/30 flex flex-col max-h-[90vh]">
              <div className="relative flex-1 overflow-hidden bg-black">
                <img src={generatedImage} alt="Result" className="w-full h-full object-contain" />
              </div>
              
              <div className="p-5 flex flex-col gap-3 bg-luxury-surface border-t border-white/5">
                <button onClick={handleShare} className="w-full gold-gradient text-luxury-black font-black py-4 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-luxury-gold/20 active:scale-95 transition-transform">
                  <span className="material-symbols-outlined">share</span>
                  <span className="tracking-widest text-sm">مشاركة الصورة</span>
                </button>
                <button onClick={() => setGeneratedImage(null)} className="w-full py-4 rounded-xl border border-white/10 text-white/60 uppercase text-xs font-bold hover:bg-white/5 hover:text-white transition-colors">إغلاق / التقاط صورة أخرى</button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default TryOnScreen;
