const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 关键文件列表（需要校验的文件）
const CRITICAL_FILES = [
  'src/server/index.js',
  'src/tools/developerTool.js'
];

// 排除文件列表（不参与校验的目录）
const EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'data',
  'coverage',
  '.nyc_output'
];

class CodeIntegrity {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.signatureFile = path.join(projectRoot, '.code-signature');
  }

  // 规范化路径（统一使用正斜杠）
  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/');
  }

  // 计算文件的SHA256哈希
  calculateFileHash(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    } catch (error) {
      console.error(`计算文件哈希失败: ${filePath}`, error.message);
      return null;
    }
  }

  // 扫描项目中的所有JS文件
  scanProjectFiles() {
    const files = [];
    
    const scanDir = (dir) => {
      try {
        const items = fs.readdirSync(dir);
        
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const relativePath = this.normalizePath(path.relative(this.projectRoot, fullPath));
          
          // 跳过排除目录
          if (EXCLUDE_DIRS.some(exclude => relativePath.startsWith(exclude))) {
            continue;
          }
          
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory()) {
            // 跳过系统目录
            if (item.startsWith('SendTo') || item.startsWith('Templates') || 
                item.startsWith('「开始」菜单') || item.startsWith('Links')) {
              continue;
            }
            scanDir(fullPath);
          } else if (stat.isFile() && (item.endsWith('.js') || item.endsWith('.json'))) {
            files.push(relativePath);
          }
        }
      } catch (error) {
        // 忽略权限错误（如系统目录）
        if (!error.message.includes('EPERM')) {
          console.error(`扫描目录失败: ${dir}`, error.message);
        }
      }
    };
    
    scanDir(this.projectRoot);
    return files;
  }

  // 生成代码签名
  generateSignature() {
    console.log('开始生成代码签名...');
    
    const signatures = {};
    const allFiles = this.scanProjectFiles();
    
    for (const file of allFiles) {
      const fullPath = path.join(this.projectRoot, file);
      const hash = this.calculateFileHash(fullPath);
      
      if (hash) {
        signatures[file] = {
          hash: hash,
          timestamp: Date.now(),
          size: fs.statSync(fullPath).size
        };
        console.log(`✓ 已签名: ${file}`);
      }
    }
    
    const signatureData = {
      version: '1.0',
      created: new Date().toISOString(),
      projectRoot: this.projectRoot,
      files: signatures,
      totalFiles: Object.keys(signatures).length
    };
    
    // 保存签名文件
    fs.writeFileSync(
      this.signatureFile,
      JSON.stringify(signatureData, null, 2),
      'utf8'
    );
    
    console.log(`代码签名生成完成，共 ${Object.keys(signatures).length} 个文件`);
    return signatureData;
  }

  // 验证代码完整性
  verifyIntegrity() {
    console.log('开始验证代码完整性...');
    
    if (!fs.existsSync(this.signatureFile)) {
      console.error('签名文件不存在，请先运行 generateSignature()');
      return { valid: false, message: '签名文件不存在' };
    }
    
    try {
      const signatureData = JSON.parse(
        fs.readFileSync(this.signatureFile, 'utf8')
      );
      
      const results = {
        valid: true,
        modified: [],
        added: [],
        removed: [],
        totalChecked: 0,
        totalValid: 0
      };
      
      const signedEntries = signatureData.files && typeof signatureData.files === 'object'
        ? Object.entries(signatureData.files)
        : [];

      // 检查已签名的文件是否被修改
      for (const [file, info] of signedEntries) {
        const fullPath = path.join(this.projectRoot, file);
        results.totalChecked++;
        
        if (!fs.existsSync(fullPath)) {
          results.removed.push(file);
          results.valid = false;
        } else {
          const currentHash = this.calculateFileHash(fullPath);
          if (currentHash !== info.hash) {
            results.modified.push({
              file: file,
              oldHash: info.hash,
              newHash: currentHash
            });
            results.valid = false;
          } else {
            results.totalValid++;
          }
        }
      }
      
      // 空签名（{"files":{}}）或字段缺失不能算通过：没有任何基线可比时是「无法验证」，不是「验证通过」
      if (results.totalChecked === 0) {
        results.valid = false;
        results.message = '签名文件不含任何文件条目，无法验证';
      }

      // 检查是否有新增文件
      const currentFiles = this.scanProjectFiles();
      const signedFiles = Object.keys(signatureData.files || {});
      
      for (const file of currentFiles) {
        if (!signedFiles.includes(file)) {
          results.added.push(file);
        }
      }
      
      // 输出结果
      if (results.valid) {
        console.log(`✓ 代码完整性验证通过 (${results.totalValid}/${results.totalChecked} 文件)`);
      } else {
        console.error('✗ 代码完整性验证失败:');
        if (results.modified.length > 0) {
          console.error(`  修改的文件: ${results.modified.length}`);
          results.modified.forEach(m => console.error(`    - ${m.file}`));
        }
        if (results.removed.length > 0) {
          console.error(`  删除的文件: ${results.removed.length}`);
          results.removed.forEach(f => console.error(`    - ${f}`));
        }
        if (results.added.length > 0) {
          console.error(`  新增的文件: ${results.added.length}`);
          results.added.forEach(f => console.error(`    - ${f}`));
        }
      }
      
      return results;
    } catch (error) {
      console.error('验证代码完整性失败:', error.message);
      return { valid: false, message: error.message };
    }
  }

  // 检查是否被木马替代（基于关键文件）
  checkCriticalFiles() {
    console.log('检查关键文件完整性...');
    
    const results = {
      secure: true,
      issues: []
    };
    
    for (const file of CRITICAL_FILES) {
      // 构建正确的路径（适配Windows）
      const normalizedFile = this.normalizePath(file);
      const fullPath = path.join(this.projectRoot, normalizedFile);
      
      if (!fs.existsSync(fullPath)) {
        results.issues.push({
          type: 'missing',
          file: file,
          fullPath: fullPath,
          message: `关键文件缺失: ${file}`
        });
        results.secure = false;
      } else {
        // 检查文件内容是否包含可疑特征
        const content = fs.readFileSync(fullPath, 'utf8');
        const suspiciousPatterns = [
          /eval\s*\(\s*require\s*\(\s*['"]crypto['"]\s*\)\s*\)/i,
          /process\.env\s*\.\s*\w+\s*&&\s*require\s*\(/i,
          /setTimeout\s*\(\s*function\s*\(\s*\)\s*{\s*require\s*\(/i,
          /child_process\s*\.\s*exec\s*\(\s*.*\s*rm\s+-rf/i,
          /fs\s*\.\s*writeFileSync\s*\([^,]+,\s*.*\s*Buffer\.from\s*\(/i
        ];
        
        for (const pattern of suspiciousPatterns) {
          if (pattern.test(content)) {
            results.issues.push({
              type: 'suspicious',
              file: file,
              message: `发现可疑代码模式: ${file}`
            });
            results.secure = false;
          }
        }
      }
    }
    
    if (results.secure) {
      console.log('✓ 关键文件安全检查通过');
    } else {
      console.error('✗ 安全检查发现问题:');
      results.issues.forEach(issue => {
        console.error(`  [${issue.type}] ${issue.message}`);
        if (issue.fullPath) {
          console.error(`    路径: ${issue.fullPath}`);
        }
      });
    }
    
    return results;
  }

  // 初始化签名文件（如果不存在）
  initializeIfNeeded() {
    if (!fs.existsSync(this.signatureFile)) {
      console.log('签名文件不存在，正在初始化...');
      return this.generateSignature();
    }
    return null;
  }

  // 导出签名信息（供外部使用）
  exportSignatureInfo() {
    if (!fs.existsSync(this.signatureFile)) {
      return null;
    }
    
    try {
      const data = JSON.parse(
        fs.readFileSync(this.signatureFile, 'utf8')
      );
      
      return {
        totalFiles: data.totalFiles,
        created: data.created,
        lastVerified: data.lastVerified || null
      };
    } catch (error) {
      return null;
    }
  }

  // 更新签名（标记验证时间）
  updateVerificationTime() {
    if (fs.existsSync(this.signatureFile)) {
      try {
        const data = JSON.parse(
          fs.readFileSync(this.signatureFile, 'utf8')
        );
        data.lastVerified = new Date().toISOString();
        fs.writeFileSync(
          this.signatureFile,
          JSON.stringify(data, null, 2),
          'utf8'
        );
      } catch (error) {
        console.error('更新验证时间失败:', error.message);
      }
    }
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  const projectRoot = path.join(__dirname, '..', '..');
  const integrity = new CodeIntegrity(projectRoot);
  
  const args = process.argv[2] || 'verify';
  
  switch (args) {
    case 'generate':
      integrity.generateSignature();
      break;
    case 'verify':
      integrity.verifyIntegrity();
      integrity.checkCriticalFiles();
      break;
    case 'check':
      integrity.checkCriticalFiles();
      break;
    default:
      console.log('用法: node codeIntegrity.js [generate|verify|check]');
  }
}

module.exports = CodeIntegrity;