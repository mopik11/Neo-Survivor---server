const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Povoluje připojení z tvých GitHub Pages
});

const ROOMS = {};

const CONFIG = {
    ENEMY_BASE_HEALTH: 20,
    ENEMY_BASE_SPEED: 2.2,
    SPAWN_INTERVAL: 800,
    BOSS_INTERVAL: 60
};

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

io.on('connection', (socket) => {
    console.log('Hráč připojen:', socket.id);
    let currentRoom = null;

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        currentRoom = roomId;

        if (!ROOMS[roomId]) {
            ROOMS[roomId] = {
                id: roomId,
                players: {},
                enemies: [],
                gems: [],
                time: 0,
                lastBossTime: 0
            };
        }

        ROOMS[roomId].players[socket.id] = {
            id: socket.id, x: 0, y: 0, hp: 120, maxHp: 120, dead: false, hat: null, level: 1
        };

        socket.emit('joined', roomId);
    });

    socket.on('playerUpdate', (data) => {
        if (currentRoom && ROOMS[currentRoom] && ROOMS[currentRoom].players[socket.id]) {
            Object.assign(ROOMS[currentRoom].players[socket.id], data);
        }
    });

    socket.on('shoot', (projData) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('enemyShoot', projData);
        }
    });

    socket.on('enemyHit', (data) => {
        if (currentRoom && ROOMS[currentRoom]) {
            const enemy = ROOMS[currentRoom].enemies.find(e => e.id === data.id);
            if (enemy) {
                enemy.hp -= data.damage;
                if (enemy.hp <= 0) {
                    ROOMS[currentRoom].enemies = ROOMS[currentRoom].enemies.filter(e => e.id !== data.id);
                    ROOMS[currentRoom].gems.push({ id: Math.random().toString(36).substr(2, 9), x: enemy.x, y: enemy.y });
                }
            }
        }
    });

    socket.on('gemPickup', (gemId) => {
        if (currentRoom && ROOMS[currentRoom]) {
            ROOMS[currentRoom].gems = ROOMS[currentRoom].gems.filter(g => g.id !== gemId);
            // Rozešleme info, že gem byl sebrán
            io.to(currentRoom).emit('gemCollected', { gemId: gemId, playerId: socket.id });
        }
    });

    socket.on('disconnect', () => {
        console.log('Hráč odpojen:', socket.id);
        if (currentRoom && ROOMS[currentRoom]) {
            delete ROOMS[currentRoom].players[socket.id];
            if (Object.keys(ROOMS[currentRoom].players).length === 0) {
                delete ROOMS[currentRoom]; // Zrušit prázdnou místnost
            }
        }
    });
});

// Hlavní smyčka serveru (20x za vteřinu)
setInterval(() => {
    for (const roomId in ROOMS) {
        const room = ROOMS[roomId];
        room.time += 1 / 20;

        const playersArr = Object.values(room.players).filter(p => !p.dead);
        
        // Spawn nepřátel
        if (playersArr.length > 0 && Math.random() < (1 / (20 * (CONFIG.SPAWN_INTERVAL / 1000)))) {
            const pivot = playersArr[Math.floor(Math.random() * playersArr.length)];
            const a = Math.random() * Math.PI * 2;
            const radius = 700;
            const x = pivot.x + Math.cos(a) * radius;
            const y = pivot.y + Math.sin(a) * radius;
            const mod = Math.floor(room.time / 60) + 1;
            
            let isBoss = false;
            let hp = CONFIG.ENEMY_BASE_HEALTH * mod;
            
            if (pivot.level >= 20 && (room.time - room.lastBossTime > CONFIG.BOSS_INTERVAL)) {
                isBoss = true;
                hp = CONFIG.ENEMY_BASE_HEALTH * 30 * mod;
                room.lastBossTime = room.time;
            }

            room.enemies.push({
                id: Math.random().toString(36).substr(2, 9),
                x: x, y: y, hp: hp, maxHp: hp, isBoss: isBoss, type: 1
            });
        }

        // Pohyb nepřátel k nejbližšímu hráči
        room.enemies.forEach(enemy => {
            if (playersArr.length === 0) return;
            const target = playersArr.sort((a, b) => dist(enemy.x, enemy.y, a.x, a.y) - dist(enemy.x, enemy.y, b.x, b.y))[0];
            const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
            const speed = (CONFIG.ENEMY_BASE_SPEED + (Math.floor(room.time / 60) * 0.15)) * (enemy.isBoss ? 0.8 : 1);
            enemy.x += Math.cos(angle) * speed;
            enemy.y += Math.sin(angle) * speed;
        });

        // Odeslání stavu všem v místnosti
        io.to(roomId).emit('stateUpdate', {
            players: room.players,
            enemies: room.enemies,
            gems: room.gems,
            time: room.time
        });
    }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server bezi na portu ${PORT}`));
