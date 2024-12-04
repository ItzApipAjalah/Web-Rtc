const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
const { ExpressPeerServer } = require('peer');
const path = require('path');

app.use(express.static('public'));

// Add this middleware before your routes
app.use((req, res, next) => {
    // Check if we're coming from a refresh/redirect
    if (req.cookies && req.cookies.redirectTo === '/') {
        res.clearCookie('redirectTo');
        if (req.path !== '/') {
            return res.redirect('/');
        }
    }
    next();
});

// Create peer server with explicit port
const peerServer = ExpressPeerServer(server, {
    debug: true,
    port: 3000,
    path: '/'
});

// Mount peer server
app.use('/peerjs', peerServer);

// Keep track of active rooms and their participants
const rooms = new Map(); // roomId -> { participants: Set, createdAt: Date, isPrivate: boolean }

// Serve landing page for root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Handle room creation
app.get('/create-room', (req, res) => {
    const roomId = req.query.roomId || generateRoomId();
    const isPrivate = req.query.private === 'true';
    
    // Create the room if it doesn't exist
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            participants: new Set(),
            createdAt: new Date(),
            isPrivate: isPrivate
        });
    }
    
    // For private rooms, include the private token
    const queryParams = new URLSearchParams({
        token: 'access_granted',
        ...(isPrivate && { privateToken: roomId })
    });
    
    res.redirect(`/room/${roomId}?${queryParams.toString()}`);
});

// Handle joining existing room
app.get('/room/:room', (req, res) => {
    const roomId = req.params.room;
    
    // Check if room exists
    const room = rooms.get(roomId);
    if (!room) {
        return res.redirect('/?error=' + encodeURIComponent('Room not found or has expired'));
    }

    // Check access for private rooms
    if (room.isPrivate) {
        const privateToken = req.query.privateToken;
        // Only allow access if they have the private token or are the creator
        if (!privateToken || privateToken !== roomId) {
            return res.redirect('/?error=' + encodeURIComponent('This is a private room. Please ask for the private link.'));
        }
    }

    // Check if the request has a valid room access token
    const roomToken = req.query.token;
    if (!roomToken || roomToken !== 'access_granted') {
        return res.redirect('/?error=' + encodeURIComponent('Please enter room code to join'));
    }
    
    res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Add these routes before your existing routes
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Add a new endpoint to check room existence
app.get('/api/check-room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    
    if (!room) {
        res.json({ exists: false });
        return;
    }
    
    res.json({ 
        exists: true,
        isPrivate: room.isPrivate
    });
});

// Add near other route handlers
app.get('/api/active-rooms', async (req, res) => {
    try {
        const activeRooms = Array.from(rooms.entries())
            .filter(([_, room]) => !room.isPrivate) // Only include public rooms
            .map(([roomId, room]) => ({
                roomId,
                participantCount: room.participants.size,
                createdAt: room.createdAt,
                participants: Array.from(room.participants).map(p => ({
                    username: p.username
                }))
            }));
        
        res.json({ rooms: activeRooms });
    } catch (error) {
        console.error('Error fetching rooms:', error);
        res.status(500).json({ error: 'Failed to fetch rooms' });
    }
});

io.on('connection', socket => {
    socket.on('join-room', (roomId, userId, username) => {
        console.log(`User ${userId} (${username}) attempting to join room ${roomId}`);
        
        // Check if room exists
        if (!rooms.has(roomId)) {
            socket.emit('room-error', 'Room not found or has expired');
            return;
        }

        // Get the room's participants Set
        const room = rooms.get(roomId);
        const participants = room.participants;

        // Notify others to clean up old connections for this user
        socket.to(roomId).emit('user-refreshed', userId);

        // Remove any existing entries for this user
        for (let participant of participants) {
            if (participant.userId === userId) {
                participants.delete(participant);
            }
        }

        // Leave any previous rooms
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id) {
                socket.leave(room);
            }
        });

        // Join the room
        socket.join(roomId);
        
        // Add user to room tracking with username
        const participant = { userId, username };
        participants.add(participant);

        // Get existing participants (excluding the current user)
        const existingParticipants = Array.from(participants)
            .filter(p => p.userId !== userId);

        // Send existing participants to the new user
        socket.emit('existing-participants', existingParticipants);

        // Notify others about the new user
        socket.to(roomId).emit('user-connected', userId, username);
        
        console.log(`User ${userId} (${username}) joined room ${roomId}`);
        console.log(`Room ${roomId} participants:`, [...participants]);

        socket.on('disconnect', () => {
            console.log(`User ${userId} (${username}) disconnecting from room ${roomId}`);
            if (rooms.has(roomId)) {
                // Remove user from room
                const room = rooms.get(roomId);
                const participants = room.participants;
                
                for (let p of participants) {
                    if (p.userId === userId) {
                        participants.delete(p);
                        break;
                    }
                }

                // Clean up empty room
                if (participants.size === 0) {
                    rooms.delete(roomId);
                }

                // Notify others about the disconnection
                socket.to(roomId).emit('user-disconnected', userId);
                console.log(`User ${userId} (${username}) left room ${roomId}`);
                console.log(`Room ${roomId} participants:`, 
                    rooms.has(roomId) ? [...rooms.get(roomId).participants] : 'Room empty');
            }
        });

        socket.on('force-disconnect', (roomId, userId) => {
            console.log(`Force disconnecting user ${userId} from room ${roomId}`);
            
            // Force immediate cleanup
            socket.leave(roomId);
            socket._cleanup && socket._cleanup(); // Force socket cleanup
            
            if (rooms.has(roomId)) {
                const room = rooms.get(roomId);
                const participants = room.participants;
                
                for (let p of participants) {
                    if (p.userId === userId) {
                        participants.delete(p);
                        break;
                    }
                }
                
                // Clean up empty room
                if (participants.size === 0) {
                    rooms.delete(roomId);
                    console.log(`Room ${roomId} deleted - no participants left`);
                }
                
                // Notify others immediately and force their cleanup
                io.to(roomId).emit('user-disconnected', userId);
            }
            
            // Force socket cleanup and disconnect
            socket.removeAllListeners();
            socket.disconnect(true);
        });

        socket.on('screen-share-stopped', (roomId, userId) => {
            // Broadcast to all users in the room that the screen share has stopped
            socket.to(roomId).emit('screen-share-stopped', userId);
        });
    });
});

function generateRoomId() {
    return Math.random().toString(36).substring(2, 7);
}

server.listen(3000, () => {
    console.log('Server running on port 3000');
});