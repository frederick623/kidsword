import { TextToSpeech } from "@capacitor-community/text-to-speech";

const EMOJI_RE = /\p{Extended_Pictographic}|\uFE0F|\u200D/gu;

/** Read text aloud with the native TTS engine (works offline on iOS/Android). */
export async function speak(text: string, slow = false): Promise<void> {
  const clean = text.replace(EMOJI_RE, "").replace(/_{3,}/g, "blank").trim();
  if (!clean) return;
  try {
    await TextToSpeech.stop();
    await TextToSpeech.speak({ text: clean, lang: "en-US", rate: slow ? 0.85 : 0.95, pitch: 1.08, volume: 1.0 });
  } catch {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(clean);
      utter.rate = slow ? 0.88 : 0.96;
      utter.pitch = 1.08;
      window.speechSynthesis.speak(utter);
    }
  }
}
