const fs = require('fs');

function fixSubmitAuth(filename) {
    let content = fs.readFileSync(filename, 'utf8');
    content = content.replace(/initAuthUI\(\);/g, 'initUI();\n                        if (typeof fetchJobs === "function") fetchJobs();\n                        if (typeof fetchReservations === "function") fetchReservations();');
    fs.writeFileSync(filename, content);
    console.log('Fixed submitAuth in ' + filename);
}

fixSubmitAuth('tutor.html');
fixSubmitAuth('study-room.html');