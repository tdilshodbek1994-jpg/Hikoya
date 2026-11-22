// .env faylni yuklaydi (Node 20.12+ ichki imkoniyati). Fayl bo'lmasa jim o'tadi.
try {
  process.loadEnvFile();
} catch {
  // .env yo'q - muhit o'zgaruvchilari tizimdan olinadi
}
