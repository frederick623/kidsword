import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.kidsword.app",
  appName: "KidsWord",
  webDir: "dist",
  android: {
    // Fully offline app: never load remote content or allow cleartext traffic
    allowMixedContent: false
  }
};

export default config;
