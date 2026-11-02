// Add the permissions the app needs to the generated native projects.
// Safe to run repeatedly (after `npx cap add android|ios`).
import fs from 'node:fs';

const manifest = 'android/app/src/main/AndroidManifest.xml';
if (fs.existsSync(manifest)) {
  let xml = fs.readFileSync(manifest, 'utf8');
  const perms = [
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  ];
  for (const p of perms) if (!xml.includes(p)) xml = xml.replace('</manifest>', `    ${p}\n</manifest>`);
  fs.writeFileSync(manifest, xml);
  console.log('Android: camera permission added');
}

const plist = 'ios/App/App/Info.plist';
if (fs.existsSync(plist)) {
  let xml = fs.readFileSync(plist, 'utf8');
  const keys = {
    NSCameraUsageDescription: 'The live camera shows a waveform of the projected picture in real time.',
    NSPhotoLibraryUsageDescription: 'Open photos and videos of your projector screen to analyse them.',
    NSPhotoLibraryAddUsageDescription: 'Save waveform images and videos to your photo library.',
  };
  for (const [k, v] of Object.entries(keys)) {
    if (!xml.includes(`<key>${k}</key>`)) xml = xml.replace(/<dict>/, `<dict>\n\t<key>${k}</key>\n\t<string>${v}</string>`);
  }
  fs.writeFileSync(plist, xml);
  console.log('iOS: usage descriptions added');
}
