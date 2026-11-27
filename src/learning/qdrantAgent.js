const https = require('https');

// 🌐 Qdrant Cloud 专用 HTTPS agent
// Node 22+ / OpenSSL 3.5 默认在 ClientHello 里带上 X25519MLKEM768 这个混合后量子密钥交换，
// 部分跨境链路会直接把它重置：表现为握手卡 10~30 秒后 ECONNRESET（curl、浏览器反而正常）。
// 这里显式限定经典曲线，握手回到 1~2 秒，协议仍然是 TLS 1.3。
const httpsAgent = new https.Agent({
    keepAlive: true,
    ecdhCurve: 'X25519:P-256:P-384'
});

module.exports = { httpsAgent };
