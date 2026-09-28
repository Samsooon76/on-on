const { withXcodeProject, withDangerousMod, IOSConfig } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

function addIosSounds(project, projectRoot, nativeRoot, projectName) {
  for (const name of ['ringtone.wav', 'incoming.wav']) {
    const relative = `${projectName}/${name}`;
    fs.copyFileSync(path.join(projectRoot, 'assets/sounds', name), path.join(nativeRoot, relative));
    if (!project.hasFile(relative)) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({ filepath: relative, groupName: projectName, isBuildFile: true, project });
    }
  }
  return project;
}

module.exports = function withCallSounds(config) {
  config = withXcodeProject(config, (mod) => {
    addIosSounds(mod.modResults, mod.modRequest.projectRoot, mod.modRequest.platformProjectRoot, mod.modRequest.projectName);
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const destination = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/raw');
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ['incoming.wav', 'ringtone.wav']) {
      fs.copyFileSync(path.join(mod.modRequest.projectRoot, 'assets/sounds', name), path.join(destination, name));
    }
    return mod;
  }]);
};
module.exports.addIosSounds = addIosSounds;
