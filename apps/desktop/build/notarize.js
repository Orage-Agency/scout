// Notarization hook invoked by electron-builder after signing. Skipped unless
// all three Apple env vars are present so unsigned dev builds still work.

const { notarize } = require("@electron/notarize");

module.exports = async function (context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !password || !teamId) {
    console.log("[notarize] Apple env vars not set — skipping notarization");
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] submitting ${appPath}`);
  await notarize({
    tool: "notarytool",
    appPath,
    appleId,
    appleIdPassword: password,
    teamId,
  });
  console.log("[notarize] done");
};
