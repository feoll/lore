import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const emptySecretPhrase = "";

function parsePhrasesFromSecret(rawValue: string | undefined): string[] {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      const normalized = parsed.map((item) => String(item).trim()).filter(Boolean);
      return normalized;
    }
  } catch {}

  const normalized = rawValue
    .split(/\|\||\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  return normalized;
}

function PetFace() {
  return (
    <motion.div
      className="relative flex h-14 w-14 items-center justify-center rounded-[1.2rem] bg-gradient-to-b from-orange-300 to-orange-500"
      animate={{ y: [0, -3, 0], rotate: [0, -2, 2, 0] }}
      transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
    >
      <motion.span
        className="absolute inset-0 rounded-[1.2rem] border border-orange-100/70"
        animate={{ scale: [1, 1.08, 1], opacity: [0.35, 0.1, 0.35] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="flex w-7 justify-between">
        <motion.span
          className="h-2 w-2 rounded-full bg-slate-900"
          animate={{ scaleY: [1, 0.2, 1, 1] }}
          transition={{ duration: 3.5, times: [0, 0.06, 0.12, 1], repeat: Infinity }}
        />
        <motion.span
          className="h-2 w-2 rounded-full bg-slate-900"
          animate={{ scaleY: [1, 0.2, 1, 1] }}
          transition={{ duration: 3.5, times: [0, 0.06, 0.12, 1], repeat: Infinity }}
        />
      </div>
      <span className="absolute top-8 h-1 w-4 rounded-full bg-slate-900" />
    </motion.div>
  );
}

export function TalkingPet() {
  const env = import.meta.env as Record<string, string | undefined>;
  const phrases = useMemo(
    () => parsePhrasesFromSecret(env.VITE_VIEW_HINT2 ?? env.VIEW_HINT2),
    [env.VITE_VIEW_HINT2, env.VIEW_HINT2]
  );
  const [speech, setSpeech] = useState(emptySecretPhrase);
  const [speechKey, setSpeechKey] = useState(0);
  const [isBubbleVisible, setIsBubbleVisible] = useState(false);

  const nextPhrase = () => {
    if (phrases.length === 0) {
      setSpeech(emptySecretPhrase);
      setSpeechKey((current) => current + 1);
      setIsBubbleVisible(true);
      return;
    }
    const random = phrases[Math.floor(Math.random() * phrases.length)];
    setSpeech(random);
    setSpeechKey((current) => current + 1);
    setIsBubbleVisible(true);
  };

  return (
    <div className="fixed right-4 bottom-4 z-20 h-36 w-56 sm:right-6 sm:bottom-6">
      <div className="absolute right-0 bottom-0">
        <motion.button
          onClick={nextPhrase}
          whileTap={{ scale: 0.94 }}
          className="flex h-16 w-16 items-center justify-center rounded-[1.4rem] border-2 border-orange-300 bg-[#fff7ef] shadow-xl shadow-orange-200/70"
          aria-label="Поговорить с кубиком"
        >
          <PetFace />
        </motion.button>
      </div>

      <AnimatePresence>
        {isBubbleVisible ? (
          <motion.div
            key="speech"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="absolute right-0 bottom-20 w-56 rounded-2xl border border-orange-100 bg-white/95 p-3 pr-8 text-sm leading-snug text-slate-700 shadow-xl shadow-orange-200/40 backdrop-blur"
          >
            <button
              onClick={() => setIsBubbleVisible(false)}
              className="absolute top-2 right-2 grid h-5 w-5 place-items-center rounded-full text-[11px] text-slate-400 transition hover:bg-orange-50 hover:text-slate-700"
              aria-label="Закрыть фразу"
            >
              x
            </button>
            <span className="mb-1 block text-[10px] font-medium tracking-wide text-orange-500">Кубик</span>
            <AnimatePresence mode="wait">
              <motion.p
                key={speechKey}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
              >
                {speech}
              </motion.p>
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
