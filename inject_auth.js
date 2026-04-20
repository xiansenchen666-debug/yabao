const fs = require('fs');

const indexHtml = fs.readFileSync('index.html', 'utf8');

// Extract Auth Modal HTML
const authModalStart = indexHtml.indexOf('<!-- 主页统一登录/注册弹窗 -->');
const authModalEnd = indexHtml.indexOf('<!-- 错误/提示 弹窗 -->');
const authModalHtml = indexHtml.substring(authModalStart, authModalEnd);

// Extract Welcome Toast HTML
const welcomeToastStart = indexHtml.indexOf('<!-- 温馨的欢迎回来 Toast 提示 -->');
const welcomeToastEnd = indexHtml.indexOf('<!-- 主页统一登录/注册弹窗 -->');
const welcomeToastHtml = indexHtml.substring(welcomeToastStart, welcomeToastEnd);

// Extract Auth JS logic
const jsStart = indexHtml.indexOf('function openAuthModal() {');
const jsEnd = indexHtml.indexOf('// 初始化拦截锚点');
const jsLogic = indexHtml.substring(jsStart, jsEnd);

console.log('Extracted HTML length:', authModalHtml.length);
console.log('Extracted JS length:', jsLogic.length);

function injectIntoFile(filename) {
    let content = fs.readFileSync(filename, 'utf8');
    
    // Inject HTML before </body>
    if (!content.includes('id="auth-modal"')) {
        content = content.replace('</body>', '\n' + welcomeToastHtml + '\n' + authModalHtml + '\n</body>');
    }
    
    // Inject JS before </script>\n</body>
    if (!content.includes('function openAuthModal()')) {
        content = content.replace('</script>\n</body>', '\n' + jsLogic + '\n</script>\n</body>');
    }
    
    // Replace goToLogin
    content = content.replace(/function goToLogin\(\) \{[\s\S]*?\}/g, 'function goToLogin() {\n            openAuthModal();\n        }');
    
    // Replace openLoginModal / closeLoginModal if they exist and are empty
    content = content.replace(/function openLoginModal\(\) \{\}/g, '');
    content = content.replace(/function closeLoginModal\(\) \{\}/g, '');
    
    // If they have old submitLogin, remove it
    content = content.replace(/async function submitLogin\([\s\S]*?finally \{\s*btn\.innerText = '登录 \/ 注册';\s*\}\s*\}/g, '');
    
    // If they have old sendCode, remove it
    content = content.replace(/async function sendCode\(\) \{[\s\S]*?btn\.disabled = false;\s*\}\s*\}/g, '');
    
    fs.writeFileSync(filename, content);
    console.log('Injected into ' + filename);
}

injectIntoFile('tutor.html');
injectIntoFile('study-room.html');