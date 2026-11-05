# 美股對決 — 手機安裝說明

## 方式一：PWA（Android / iOS 都可用，建議）

線上版：https://wuyulun0823-lab.github.io/stock-duel/

### Android（Chrome）
1. 用 Chrome 開啟上面網址
2. 選單 →「安裝應用程式」或「加到主畫面」
3. 確認安裝後，主畫面會出現「美股對決」圖示，以全螢幕獨立 App 開啟

### iOS（Safari）
1. 用 **Safari** 開啟上面網址（Chrome 無法「加到主畫面」）
2. 點分享按鈕 →「加入主畫面」
3. 名稱確認為「美股對決」後加入
4. 從主畫面圖示開啟即可全螢幕遊玩

> 對戰需網路（PeerJS）。離線時只能看到殼層頁面，無法連線開房。

## 方式二：Android APK（側載）

建置產物放在本機 `dist/stock-duel-debug.apk`（debug 簽名，可直接安裝）。

1. 把 APK 傳到手機
2. 允許「安裝未知來源應用」
3. 開啟 APK 安裝
4. 安裝後需有網路才能對戰

重新建置（開發者）：
```bash
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/android-sdk
npm install
npm run sync:www
npx cap sync android
cd android && ./gradlew assembleDebug
```

## 方式三：iOS（需 Mac + Xcode）

本倉庫已含 Capacitor `ios/` 專案，但 **無法在 Linux 產出可安裝的 IPA**（需要 Apple Developer 簽章與 Xcode）。

在 Mac 上：
```bash
npm install
npm run sync:www
npx cap sync ios
npx cap open ios
```
然後在 Xcode 選擇你的 Team 簽章，連真機 Run，或 Archive 上傳 TestFlight / App Store。

App ID：`com.stockduel.app`
