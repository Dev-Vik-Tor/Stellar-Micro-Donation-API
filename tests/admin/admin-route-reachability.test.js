const fs = require('fs');
const path = require('path');

describe('Admin Route Reachability Smoke Test (Issue #1323)', () => {
  it('should ensure every file under src/routes/admin/ is referenced or mounted in src/bootstrap/routes.js', () => {
    const adminRoutesDir = path.join(__dirname, '../../src/routes/admin');
    const bootstrapRoutesFile = path.join(__dirname, '../../src/bootstrap/routes.js');
    
    const bootstrapContent = fs.readFileSync(bootstrapRoutesFile, 'utf8');
    const adminFiles = fs.readdirSync(adminRoutesDir).filter(file => file.endsWith('.js'));

    const unmountedFiles = [];

    for (const file of adminFiles) {
      const baseName = file.replace('.js', '');
      // Check if the filename or module path is referenced in bootstrap/routes.js
      const isReferenced = bootstrapContent.includes(`routes/admin/${baseName}`) ||
                           bootstrapContent.includes(`routes/admin/${file}`);
      
      if (!isReferenced) {
        unmountedFiles.push(file);
      }
    }

    expect(unmountedFiles).toEqual([]);
  });
});
