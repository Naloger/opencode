# OpenCode CLI - Quick Start

## 🚀 Hızlı Başlangıç

### Gereksinimler
- Bun v1.3.11+
- Node.js (sistem tarafından bağımlı)
- Windows (veya macOS/Linux)

### Kurulum

```bash
cd C:\CalismaAlani\CodingJS\OpenCode\opencode
bun install
```

### CLI'yi Çalıştır

```bash
# Dev mode (kaynak dosyalardan)
bun run dev

# Help mesajı
bun run dev --help

# Spesifik komut
bun run dev run "yazabilir misin merhaba dünya programı"
```

### Build Et

```bash
cd packages/opencode

# Sadece Windows x64 için (hızlı)
bun run build --single

# Tüm platformlar için (yavaş, ~2-3 saat)
bun run build
```

**Build Sonuç:**
```
dist/opencode-windows-x64/bin/opencode.exe   # Windows
dist/opencode-darwin-arm64/bin/opencode      # macOS ARM
dist/opencode-linux-x64/bin/opencode         # Linux x64
# ...vb.
```

## 📁 Proje Yapısı

```
packages/opencode/
├── src/                    # Ana kaynak kodu
│   ├── cli/               # CLI komutları
│   ├── index.ts           # Entry point
│   └── ...
├── script/
│   └── build.ts           # Build scripti
├── dist/                  # Build çıktısı
└── package.json
```

## 🔧 Temizlemeler

Aşağıdaki paketler kaldırılmıştır:
- ❌ Desktop UI (Tauri/Electron)
- ❌ Web Interface
- ❌ Console Application
- ❌ Storybook Component Library
- ❌ Documentation Site
- ❌ UI Component Library

Bu değişiklikler CLI'yi **~500MB-1GB daha hafif** yapmıştır.

Ayrıntılar için [`BLOAT_REMOVAL.md`](./BLOAT_REMOVAL.md) dosyasına bakın.

## 📊 Bilgi

| Özellik | Değer |
|---------|-------|
| Silinen Paketler | 8 |
| Disk Tasarrufu | ~500MB-1GB |
| Build Zamanı | 30-45 saniye (tek platform) |
| CLI Duruşu | ✅ Çalışıyor |

## 🐛 Sorun Giderme

### Hata: "workspace not found"
```bash
bun install
```

### Hata: "permission denied" (build sırasında)
```powershell
Remove-Item -Path "packages/opencode/dist" -Recurse -Force
# Sonra tekrar: bun run build --single
```

### Hata: Web UI warning
Normal - packages/app silindi.
```
Skipping Web UI embedding (app package not found)
```

## 🔗 Bağlantılar

- 📖 Detaylı Rehber: [`BLOAT_REMOVAL.md`](./BLOAT_REMOVAL.md)
- 🌐 Web: https://opencode.ai
- 💬 Discord: https://opencode.ai/discord
- 📦 npm: https://www.npmjs.com/package/opencode-ai

---

**Last Updated:** 8 Nisan 2026

