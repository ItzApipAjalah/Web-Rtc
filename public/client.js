const socket = io('/');
const videoGrid = document.getElementById('video-grid');
const myVideo = document.createElement('video');
myVideo.muted = true;

// Get the room ID from the URL
const ROOM_ID = window.location.pathname.split('/')[2];

// Display room ID
document.getElementById('roomId').textContent = ROOM_ID;

// Create Peer connection
const peer = new Peer(undefined, {
    host: window.location.hostname,
    port: window.location.port || 4005,
    path: '/peerjs',
    debug: 3
});

const peers = {};
let myVideoStream;
let myPeerId = '';

// Add these near the top of your client.js file
let currentUsername = '';

// Add at the top with other declarations
const usernames = new Map(); // Store usernames for each peer ID
const activeConnections = new Set(); // Track active connections

// Add these at the top of your file
const activeStreams = new Map(); // Track active streams by peer ID
const streamEvents = new Map(); // Track stream events by peer ID
let isReconnecting = false; // Flag to prevent duplicate connections
let reconnectionTimeout = null; // To handle reconnection debouncing

// Add these variables at the top with other declarations
let screenStream = null;
let screenSharePeers = {};
let isScreenSharing = false;

// Add the screen share button handler
document.getElementById('screenShareButton').addEventListener('click', async () => {
    if (!isScreenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always"
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            // Update button state
            isScreenSharing = true;
            const screenShareButton = document.getElementById('screenShareButton');
            screenShareButton.innerHTML = `
                <svg class="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
                Stop Sharing
            `;
            screenShareButton.classList.remove('bg-blue-500/80', 'hover:bg-blue-600');
            screenShareButton.classList.add('bg-red-500/80', 'hover:bg-red-600');

            // Create video element for screen share
            const screenVideo = document.createElement('video');
            screenVideo.muted = true;
            addVideoStream(screenVideo, screenStream, `screen-${myPeerId}`, true, currentUsername);

            // Share screen with existing peers
            Object.keys(peers).forEach(peerId => {
                // Create a new peer connection for screen sharing with username info
                const screenPeer = new Peer(`screen-${myPeerId}-${peerId}`, {
                    host: window.location.hostname,
                    port: window.location.port || 4005,
                    path: '/peerjs',
                    debug: 3
                });

                screenPeer.on('open', () => {
                    const call = screenPeer.call(peerId, screenStream);
                    screenSharePeers[peerId] = {
                        peer: screenPeer,
                        call: call
                    };
                });

                screenPeer.on('error', (err) => {
                    console.error('Screen share peer error:', err);
                });
            });

            // Handle stream end
            screenStream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };

        } catch (err) {
            console.error('Error sharing screen:', err);
            Swal.fire({
                title: 'Screen Share Error',
                text: 'Failed to share screen. Please try again.',
                icon: 'error',
                background: '#1F2937',
                color: '#fff',
                confirmButtonColor: '#3B82F6'
            });
        }
    } else {
        stopScreenShare();
    }
});

// Update the stopScreenShare function
function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }

    // Remove screen share video
    const screenVideo = document.querySelector(`[data-peer="screen-${myPeerId}"]`);
    if (screenVideo) {
        screenVideo.remove();
    }

    // Emit screen share stop event to server ONCE
    socket.emit('screen-share-stopped', ROOM_ID, myPeerId);

    // Close all screen share peer connections
    Object.entries(screenSharePeers).forEach(([peerId, { peer, call }]) => {
        if (call) call.close();
        if (peer) peer.destroy();
    });
    screenSharePeers = {};

    // Reset button state
    isScreenSharing = false;
    const screenShareButton = document.getElementById('screenShareButton');
    screenShareButton.innerHTML = `
        <svg class="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
        </svg>
        Share Screen
    `;
    screenShareButton.classList.remove('bg-red-500/80', 'hover:bg-red-600');
    screenShareButton.classList.add('bg-blue-500/80', 'hover:bg-blue-600');
}

// Update the socket listener for screen share stopped
socket.on('screen-share-stopped', (userId) => {
    console.log('Screen share stopped by user:', userId);
    
    // Remove all screen share videos for this user
    const screenVideos = document.querySelectorAll(`[data-peer^="screen-${userId}"]`);
    screenVideos.forEach(video => {
        console.log('Removing screen share video:', video);
        video.remove();
    });

    // Clean up any screen share peer connections for this user
    Object.entries(screenSharePeers).forEach(([peerId, { peer, call }]) => {
        if (peerId.includes(userId)) {
            if (call) call.close();
            if (peer) peer.destroy();
            delete screenSharePeers[peerId];
        }
    });
});

// Also add this to handle when screen share is stopped by the browser
screenStream?.getVideoTracks()[0].addEventListener('ended', () => {
    stopScreenShare();
});

// Add this function to handle reconnection with debouncing
function debouncedReconnection() {
    if (reconnectionTimeout) {
        clearTimeout(reconnectionTimeout);
    }
    
    reconnectionTimeout = setTimeout(async () => {
        if (!document.hidden && document.hasFocus()) {
            console.log('Checking connections...');
            await handleReconnection();
        }
    }, 1000); // Wait 1 second before attempting reconnection
}

// Separate reconnection logic
async function handleReconnection() {
    if (isReconnecting) return;
    
    try {
        isReconnecting = true;
        console.log('Starting reconnection process...');

        // Only clean up inactive connections
        const peerIds = [...activeConnections];
        peerIds.forEach(peerId => {
            if (peerId !== myPeerId && (!peers[peerId] || !peers[peerId].open)) {
                cleanupPeerConnection(peerId, true);
            }
        });

        // Check if room still exists
        const response = await fetch(`/api/check-room/${ROOM_ID}`);
        const data = await response.json();
        
        if (!data.exists) {
            window.location.href = '/?error=' + encodeURIComponent('Room no longer exists');
            return;
        }

        // Only rejoin if we're not already connected
        if (myPeerId && currentUsername && activeConnections.size === 0) {
            socket.emit('join-room', ROOM_ID, myPeerId, currentUsername);
        }
    } catch (error) {
        console.error('Error during reconnection:', error);
    } finally {
        isReconnecting = false;
    }
}

// Get current user and set username
async function initializeUser() {
    try {
        const { user, error } = await getCurrentUser();
        if (error || !user) {
            window.location.href = '/login';
            return;
        }

        // Check if room exists before initializing
        const response = await fetch(`/api/check-room/${ROOM_ID}`);
        const data = await response.json();
        
        if (!data.exists) {
            window.location.href = '/?error=' + encodeURIComponent('Room not found or has expired');
            return;
        }

        currentUsername = user.profile.username;
        document.getElementById('username').textContent = currentUsername;
        initializeMedia();
    } catch (error) {
        console.error('Error initializing user:', error);
        window.location.href = '/?error=' + encodeURIComponent('Error initializing room');
    }
}

// Separate media initialization
function initializeMedia() {
    navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    }).then(stream => {
        myVideoStream = stream;
        addVideoStream(myVideo, stream, 'me');

        // Handle incoming calls
        peer.on('call', call => {
            console.log('Receiving call from peer:', call.peer);
            
            if (isReconnecting) {
                console.log('Ignoring call during reconnection');
                return;
            }

            const isScreenShare = call.peer.includes('screen-');
            // Extract the original peer ID from the screen share ID (new format: screen-originalPeerId-randomString)
            const actualPeerId = isScreenShare ? call.peer.split('-')[1] : call.peer;

            // Clean up any existing connection
            if (isScreenShare) {
                if (screenSharePeers[actualPeerId]) {
                    screenSharePeers[actualPeerId].close();
                }
            } else {
                cleanupPeerConnection(actualPeerId);
            }

            // Answer with appropriate stream
            call.answer(isScreenShare ? null : myVideoStream);

            const video = document.createElement('video');
            let streamAdded = false;

            call.on('stream', userVideoStream => {
                if (streamAdded) {
                    console.log('Stream already added for this call');
                    return;
                }
                
                console.log('Received stream from peer:', call.peer);
                
                if (isScreenShare) {
                    // Handle screen share stream with proper username
                    const username = usernames.get(actualPeerId) || 'Anonymous';
                    addVideoStream(video, userVideoStream, call.peer, true, username);
                    screenSharePeers[actualPeerId] = call;
                } else {
                    // Handle regular video stream
                    activeStreams.set(call.peer, userVideoStream);
                    addVideoStream(video, userVideoStream, call.peer, false);
                    peers[call.peer] = call;
                }
                
                streamAdded = true;
            });

            call.on('close', () => {
                if (isScreenShare) {
                    const screenVideo = document.querySelector(`[data-peer="${call.peer}"]`);
                    if (screenVideo) {
                        screenVideo.remove();
                    }
                    delete screenSharePeers[actualPeerId];
                } else {
                    cleanupPeerConnection(call.peer);
                }
            });

            if (!isScreenShare) {
                activeConnections.add(call.peer);
            }
        });

        // If we already have a peer ID, join the room now
        if (myPeerId) {
            socket.emit('join-room', ROOM_ID, myPeerId, currentUsername);
        }
    }).catch(err => {
        console.error('Failed to get media devices:', err);
        Swal.fire({
            title: 'Camera/Microphone Error',
            text: 'Failed to access camera and microphone. Please make sure you have granted the necessary permissions.',
            icon: 'error',
            background: '#1F2937',
            color: '#fff',
            confirmButtonColor: '#3B82F6'
        });
    });
}

// Initialize user when page loads
initializeUser();

// Update the leave room functionality to just refresh the page
document.getElementById('leaveButton').addEventListener('click', () => {
    Swal.fire({
        title: 'Leave Room?',
        text: 'Are you sure you want to leave this room?',
        icon: 'warning',
        background: '#1F2937',
        color: '#fff',
        showCancelButton: true,
        confirmButtonColor: '#EF4444',
        cancelButtonColor: '#6B7280',
        confirmButtonText: 'Yes, leave room',
        cancelButtonText: 'Cancel'
    }).then((result) => {
        if (result.isConfirmed) {
            // Clean up and disconnect
            if (myVideoStream) {
                myVideoStream.getTracks().forEach(track => track.stop());
            }
            
            // Close peer connections
            Object.values(peers).forEach(peer => {
                if (peer) peer.close();
            });
            
            // Disconnect socket
            socket.disconnect();
            
            // Navigate away
            window.location.href = '/';
        }
    });
});

// Update the existing copy button functionality
document.getElementById('copyButton').addEventListener('click', () => {
    navigator.clipboard.writeText(ROOM_ID)
        .then(() => {
            Swal.fire({
                title: 'Copied!',
                text: 'Room ID copied to clipboard!',
                icon: 'success',
                background: '#1F2937',
                color: '#fff',
                confirmButtonColor: '#3B82F6',
                timer: 1500,
                showConfirmButton: false
            });
        })
        .catch(err => {
            console.error('Failed to copy room ID:', err);
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = ROOM_ID;
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                Swal.fire({
                    title: 'Copied!',
                    text: 'Room ID copied to clipboard!',
                    icon: 'success',
                    background: '#1F2937',
                    color: '#fff',
                    confirmButtonColor: '#3B82F6',
                    timer: 1500,
                    showConfirmButton: false
                });
            } catch (err) {
                Swal.fire({
                    title: 'Error',
                    text: 'Failed to copy room ID',
                    icon: 'error',
                    background: '#1F2937',
                    color: '#fff',
                    confirmButtonColor: '#3B82F6'
                });
            }
            document.body.removeChild(textArea);
        });
});

// Add this to your existing socket connection code
socket.on('connect', () => {
    // Display room ID
    document.getElementById('roomId').textContent = ROOM_ID;
});

// Add error handling for unauthorized access
window.onerror = function(msg, url, lineNo, columnNo, error) {
    if (msg.includes('unauthorized')) {
        window.location.href = '/login';
    }
    return false;
};

// Update the user-disconnected handler
socket.on('user-disconnected', userId => {
    console.log('User disconnected:', userId);
    
    // Clean up regular video elements
    const elements = document.querySelectorAll(`[data-peer="${userId}"]`);
    elements.forEach(element => {
        console.log('Removing element for disconnected user:', userId);
        element.remove();
    });

    // Clean up screen share elements
    const screenElements = document.querySelectorAll(`[data-peer="screen-${userId}"]`);
    screenElements.forEach(element => {
        console.log('Removing screen share element for disconnected user:', userId);
        element.remove();
    });

    // Clean up peer connections
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }

    if (screenSharePeers[userId]) {
        screenSharePeers[userId].close();
        delete screenSharePeers[userId];
    }

    // Clean up all tracking data
    activeConnections.delete(userId);
    activeStreams.delete(userId);
    usernames.delete(userId);
});

// Add this function to handle when we detect a user refreshing
function handleUserRefresh(userId) {
    console.log('Handling user refresh:', userId);
    
    // Remove all existing videos for this user first
    const allVideos = document.querySelectorAll(`.video-wrapper[data-peer="${userId}"]`);
    if (allVideos.length > 0) {
        console.log(`Found ${allVideos.length} videos to clean up for refreshing user:`, userId);
        allVideos.forEach(videoWrapper => {
            const videoElement = videoWrapper.querySelector('video');
            if (videoElement && videoElement.srcObject) {
                const tracks = videoElement.srcObject.getTracks();
                tracks.forEach(track => {
                    track.stop();
                    videoElement.srcObject.removeTrack(track);
                });
                videoElement.srcObject = null;
            }
            videoWrapper.remove();
        });
    }

    // Clean up old connections but keep tracking data
    if (peers[userId]) {
        console.log('Cleaning up peer connection for refreshing user:', userId);
        peers[userId].close();
        delete peers[userId];
    }

    // Remove from active tracking but keep username
    activeConnections.delete(userId);
    activeStreams.delete(userId);
}

// Update the socket.on('user-connected') handler
socket.on('user-connected', (userId, username) => {
    console.log('User connected:', userId, 'Username:', username);
    
    // If this user was already connected, treat it as a refresh
    if (activeConnections.has(userId)) {
        console.log('Existing user reconnected, handling as refresh:', userId);
        handleUserRefresh(userId);
    }
    
    usernames.set(userId, username);
    
    // Clean up any existing duplicates first
    cleanupDuplicateVideos(userId);
    
    // Don't connect if we already have an active connection
    if (userId !== myPeerId && myVideoStream && !activeConnections.has(userId)) {
        // Delay the connection slightly to ensure everything is ready
        setTimeout(() => {
            connectToNewUser(userId, myVideoStream);
        }, 1000);
    }
});

socket.on('existing-participants', (participants) => {
    console.log('Existing participants:', participants);
    participants.forEach(({ userId, username }) => {
        if (userId !== myPeerId && !activeConnections.has(userId)) {
            usernames.set(userId, username);
            if (myVideoStream) {
                connectToNewUser(userId, myVideoStream);
            }
        }
    });
});

// Update peer connection handler
peer.on('open', id => {
    console.log('My peer ID is:', id);
    myPeerId = id;
    // Only join room if we have both the video stream and username
    if (myVideoStream && currentUsername) {
        socket.emit('join-room', ROOM_ID, id, currentUsername);
    }
});

peer.on('error', error => {
    console.error('Peer connection error:', error);
});

// Add near the top with other declarations
const STREAM_TIMEOUT = 15000; // 15 seconds timeout for streams

// Update the addVideoStream function to include loading state
function addVideoStream(video, stream, peerId, isScreenShare = false, screenShareUsername = null) {
    console.log('Adding video stream for peer:', peerId);
    
    // Clean up any duplicate videos first
    cleanupDuplicateVideos(peerId);

    // Create new video wrapper
    const wrapper = document.createElement('div');
    wrapper.className = `relative rounded-lg overflow-hidden bg-gray-800 ${isScreenShare ? 'col-span-2 row-span-2' : ''}`;
    wrapper.setAttribute('data-peer', peerId);
    
    // Add loading spinner
    const loadingSpinner = document.createElement('div');
    loadingSpinner.className = 'absolute inset-0 flex items-center justify-center';
    loadingSpinner.innerHTML = `
        <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
    `;
    wrapper.appendChild(loadingSpinner);
    
    // Set up video element
    video.srcObject = stream;
    video.className = 'w-full h-full object-contain opacity-0 transition-opacity duration-300';
    
    let playAttempts = 0;
    const maxPlayAttempts = 3;
    let streamTimeout;

    // Set stream timeout
    streamTimeout = setTimeout(() => {
        if (video.classList.contains('opacity-0')) {
            console.log('Stream timeout - cleaning up');
            cleanupPeerConnection(peerId, true);
        }
    }, STREAM_TIMEOUT);

    // Add error handling for video playback with retries
    video.addEventListener('loadedmetadata', () => {
        const attemptPlay = async () => {
            try {
                await video.play();
                // Show video and remove loading spinner on successful play
                video.classList.remove('opacity-0');
                if (loadingSpinner.parentNode) {
                    loadingSpinner.remove();
                }
                clearTimeout(streamTimeout);
            } catch (e) {
                console.warn(`Play attempt ${playAttempts + 1} failed:`, e);
                playAttempts++;
                
                if (playAttempts < maxPlayAttempts) {
                    console.log(`Retrying play, attempt ${playAttempts + 1}...`);
                    setTimeout(attemptPlay, 1000);
                } else {
                    console.error('Max play attempts reached, cleaning up connection');
                    cleanupPeerConnection(peerId, true);
                }
            }
        };
        
        attemptPlay();
    });

    // Update error handling
    video.addEventListener('error', (e) => {
        console.error('Video error:', e);
        if (stream.active) {
            console.log('Attempting to reattach active stream');
            video.srcObject = null;
            // Show loading spinner again
            wrapper.appendChild(loadingSpinner);
            video.classList.add('opacity-0');
            
            setTimeout(() => {
                video.srcObject = stream;
            }, 1000);
        } else {
            cleanupPeerConnection(peerId, true);
        }
    });

    // Update the username label for screen shares
    const usernameDiv = document.createElement('div');
    usernameDiv.className = 'absolute bottom-3 left-3 bg-black/70 px-3 py-1 rounded-lg text-sm';
    
    if (isScreenShare) {
        if (peerId === `screen-${myPeerId}`) {
            usernameDiv.textContent = `${currentUsername}'s Screen`;
        } else if (screenShareUsername) {
            usernameDiv.textContent = `${screenShareUsername}'s Screen`;
        } else {
            // Extract username from peer ID for legacy connections
            const originalPeerId = peerId.split('-')[1];
            const username = usernames.get(originalPeerId) || 'Anonymous';
            usernameDiv.textContent = `${username}'s Screen`;
        }
    } else {
        usernameDiv.textContent = peerId === 'me' ? currentUsername : (usernames.get(peerId) || 'Anonymous');
    }
    
    // Add status indicators container
    const statusContainer = document.createElement('div');
    statusContainer.className = 'absolute top-3 right-3 flex gap-2';
    
    // Add audio status indicator
    const audioStatus = document.createElement('div');
    audioStatus.className = 'status-icon';
    audioStatus.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="text-white" viewBox="0 0 16 16">
            <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z"/>
            <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5z"/>
        </svg>
    `;
    
    // Add video status indicator
    const videoStatus = document.createElement('div');
    videoStatus.className = 'status-icon';
    videoStatus.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="text-white" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2V5z"/>
        </svg>
    `;

    // Add the status indicators to the container
    statusContainer.appendChild(audioStatus);
    statusContainer.appendChild(videoStatus);
    
    // Add the status container to the wrapper
    wrapper.appendChild(statusContainer);

    // Update status indicators when tracks are muted/unmuted
    stream.getAudioTracks().forEach(track => {
        track.onmute = () => updateAudioStatus(audioStatus, false);
        track.onunmute = () => updateAudioStatus(audioStatus, true);
        updateAudioStatus(audioStatus, track.enabled);
    });

    stream.getVideoTracks().forEach(track => {
        track.onmute = () => updateVideoStatus(videoStatus, false);
        track.onunmute = () => updateVideoStatus(videoStatus, true);
        updateVideoStatus(videoStatus, track.enabled);
    });

    // Assemble and add to grid
    wrapper.appendChild(video);
    wrapper.appendChild(usernameDiv);
    videoGrid.append(wrapper);

    // Store the stream
    activeStreams.set(peerId, stream);
}

// Update the connectToNewUser function to handle screen sharing
function connectToNewUser(userId, stream) {
    console.log('Connecting to new user:', userId);
    
    if (userId === myPeerId || isReconnecting) {
        console.log('Skipping connection (self or reconnecting)');
        return;
    }

    // Don't connect if we already have an active connection
    if (activeConnections.has(userId) && peers[userId] && peers[userId].open) {
        console.log('Already have active connection to:', userId);
        return;
    }

    // Clean up any existing connection
    cleanupPeerConnection(userId, true);

    // Make regular video call
    const call = peer.call(userId, stream);
    const video = document.createElement('video');
    let streamAdded = false;
    
    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
        if (!streamAdded) {
            console.log('Connection timeout - cleaning up');
            cleanupPeerConnection(userId, true);
        }
    }, STREAM_TIMEOUT);

    call.on('stream', userVideoStream => {
        clearTimeout(connectionTimeout);
        
        if (streamAdded || activeStreams.has(userId)) {
            console.log('Stream already added for this call');
            return;
        }
        
        console.log('Received stream from user:', userId);
        activeStreams.set(userId, userVideoStream);
        addVideoStream(video, userVideoStream, userId);
        streamAdded = true;
    });
    
    call.on('close', () => {
        cleanupPeerConnection(userId, true);
    });

    call.on('error', () => {
        cleanupPeerConnection(userId, true);
    });

    peers[userId] = call;
    activeConnections.add(userId);

    // If we're currently sharing screen, share it with the new user
    if (screenStream) {
        // Create a new peer connection for screen sharing
        const screenPeer = new Peer(`screen-${myPeerId}-${userId}`, {
            host: window.location.hostname,
            port: window.location.port || 4005,
            path: '/peerjs',
            debug: 3
        });

        screenPeer.on('open', () => {
            const screenCall = screenPeer.call(userId, screenStream);
            screenSharePeers[userId] = {
                peer: screenPeer,
                call: screenCall
            };
        });

        screenPeer.on('error', (err) => {
            console.error('Screen share peer error:', err);
        });
    }
}

// Add this function to handle cleanup before adding new streams
function cleanupDuplicateVideos(peerId) {
    console.log('Cleaning up duplicate videos for peer:', peerId);
    const existingVideos = Array.from(document.querySelectorAll(`.video-wrapper[data-peer="${peerId}"]`));
    
    // If there are multiple videos, remove all except the last one
    if (existingVideos.length > 1) {
        existingVideos.slice(0, -1).forEach(videoWrapper => {
            console.log('Removing duplicate video wrapper for peer:', peerId);
            const videoElement = videoWrapper.querySelector('video');
            if (videoElement && videoElement.srcObject) {
                const tracks = videoElement.srcObject.getTracks();
                tracks.forEach(track => {
                    track.stop();
                    videoElement.srcObject.removeTrack(track);
                });
                videoElement.srcObject = null;
            }
            videoWrapper.remove();
        });
    }
}

// Update the mute/unmute functionality
const muteButton = document.getElementById('muteButton');
muteButton.addEventListener('click', () => {
    if (myVideoStream) {
        const enabled = myVideoStream.getAudioTracks()[0].enabled;
        if (enabled) {
            myVideoStream.getAudioTracks()[0].enabled = false;
            muteButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06zm7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0z"/>
                </svg>
                Unmute
            `;
        } else {
            myVideoStream.getAudioTracks()[0].enabled = true;
            muteButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z"/>
                    <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5z"/>
                </svg>
                Mute
            `;
        }
    }
});

// Update the video on/off functionality
const videoButton = document.getElementById('videoButton');
videoButton.addEventListener('click', () => {
    if (myVideoStream) {
        const enabled = myVideoStream.getVideoTracks()[0].enabled;
        if (enabled) {
            myVideoStream.getVideoTracks()[0].enabled = false;
            videoButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
                    <path fill-rule="evenodd" d="M10.961 12.365a1.99 1.99 0 0 0 .522-1.103l3.11 1.382A1 1 0 0 0 16 11.731V4.269a1 1 0 0 0-1.406-.913l-3.111 1.382A2 2 0 0 0 9.5 3H4.272l6.69 9.365zm-10.114-9A2.001 2.001 0 0 0 0 5v6a2 2 0 0 0 2 2h5.728L.847 3.366zm9.746 11.925-10-14 .814-.58 10 14-.814.58z"/>
                </svg>
                Start Video
            `;
        } else {
            myVideoStream.getVideoTracks()[0].enabled = true;
            videoButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
                    <path fill-rule="evenodd" d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2V5z"/>
                </svg>
                Stop Video
            `;
        }
    }
});

// Add this near the top of your client.js file, after the socket initialization
socket.on('room-error', (errorMessage) => {
    console.error('Room error:', errorMessage);
    Swal.fire({
        title: 'Room Error',
        text: errorMessage,
        icon: 'error',
        background: '#1F2937',
        color: '#fff',
        confirmButtonColor: '#3B82F6'
    }).then(() => {
        window.location.href = '/?error=' + encodeURIComponent(errorMessage);
    });
});

// Update the cleanupPeerConnection function to be more selective
function cleanupPeerConnection(peerId, force = false) {
    console.log('Cleaning up connection for peer:', peerId);
    
    // Skip cleanup for active connections unless forced
    if (!force && peers[peerId] && peers[peerId].open) {
        console.log('Skipping cleanup for active connection:', peerId);
        return;
    }

    // Remove all video elements for this peer
    const videoElements = document.querySelectorAll(`.video-wrapper[data-peer="${peerId}"]`);
    videoElements.forEach(element => {
        console.log('Removing video element for peer:', peerId);
        const video = element.querySelector('video');
        if (video && video.srcObject) {
            const tracks = video.srcObject.getTracks();
            tracks.forEach(track => {
                track.stop();
                video.srcObject.removeTrack(track);
            });
            video.srcObject = null;
        }
        element.remove();
    });

    // Clean up peer connection
    if (peers[peerId]) {
        console.log('Closing peer connection for:', peerId);
        const peerConnection = peers[peerId];
        
        if (peerConnection.peerConnection) {
            const senders = peerConnection.peerConnection.getSenders();
            senders.forEach(sender => {
                if (sender.track) {
                    sender.track.stop();
                }
            });
        }
        
        peerConnection.close();
        delete peers[peerId];
    }

    // Clean up stream
    const stream = activeStreams.get(peerId);
    if (stream) {
        console.log('Stopping stream tracks for peer:', peerId);
        stream.getTracks().forEach(track => {
            track.stop();
            stream.removeTrack(track);
        });
        activeStreams.delete(peerId);
    }
    
    // Clear tracking data
    activeConnections.delete(peerId);

    // Add screen share cleanup
    const screenPeerId = `screen-${peerId}`;
    const screenVideo = document.querySelector(`[data-peer="${screenPeerId}"]`);
    if (screenVideo) {
        const video = screenVideo.querySelector('video');
        if (video && video.srcObject) {
            const tracks = video.srcObject.getTracks();
            tracks.forEach(track => {
                track.stop();
                video.srcObject.removeTrack(track);
            });
            video.srcObject = null;
        }
        screenVideo.remove();
    }

    if (screenSharePeers[peerId]) {
        screenSharePeers[peerId].close();
        delete screenSharePeers[peerId];
    }
}

// Keep only these visibility handlers for reconnection
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        debouncedReconnection();
    }
});

window.addEventListener('focus', () => {
    debouncedReconnection();
});

// Replace the beforeunload handler with this version
window.addEventListener('beforeunload', function(e) {
    if (myVideoStream || Object.keys(peers).length > 0) {
        // Show SweetAlert confirmation
        e.preventDefault();
        
        // We still need to set returnValue for browser's default behavior
        const message = 'Are you sure you want to leave?';
        e.returnValue = message;

        // Use our custom confirmation
        Swal.fire({
            title: 'Leave Room?',
            text: 'Are you sure you want to leave this room?',
            icon: 'warning',
            background: '#1F2937',
            color: '#fff',
            showCancelButton: true,
            confirmButtonColor: '#EF4444',
            cancelButtonColor: '#6B7280',
            confirmButtonText: 'Yes, leave room',
            cancelButtonText: 'Cancel'
        }).then((result) => {
            if (result.isConfirmed) {
                // Clean up and disconnect
                if (myVideoStream) {
                    myVideoStream.getTracks().forEach(track => track.stop());
                }
                
                // Close peer connections
                Object.values(peers).forEach(peer => {
                    if (peer) peer.close();
                });
                
                // Disconnect socket
                socket.disconnect();
                
                // Navigate away
                window.location.href = '/';
            }
        });

        return message;
    }
});

// Remove the cookie-based redirect approach
if (document.cookie.includes('redirectTo=/')) {
    document.cookie = 'redirectTo=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

// Update socket disconnect handler to force redirect
socket.on('disconnect', () => {
    console.log('Disconnected from server');
    isReconnecting = true; // Prevent reconnection attempts
    window.location.href = '/';
    window.location.replace('/');
});

// Add this to prevent any navigation back to the room
window.history.pushState(null, '', '/');

// Add this new function to handle stream recovery
function attemptStreamRecovery(peerId) {
    console.log('Attempting stream recovery for peer:', peerId);
    
    const existingStream = activeStreams.get(peerId);
    if (!existingStream || !existingStream.active) {
        console.log('No active stream to recover, cleaning up connection');
        cleanupPeerConnection(peerId, true);
        return;
    }

    const videoElement = document.querySelector(`[data-peer="${peerId}"] video`);
    if (videoElement) {
        videoElement.srcObject = null;
        setTimeout(() => {
            videoElement.srcObject = existingStream;
            videoElement.play().catch(err => {
                console.error('Failed to recover stream:', err);
                cleanupPeerConnection(peerId, true);
            });
        }, 1000);
    }
}

// Add these helper functions to update status indicators
function updateAudioStatus(element, enabled) {
    element.innerHTML = enabled ? `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="text-white" viewBox="0 0 16 16">
            <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z"/>
            <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5z"/>
        </svg>
    ` : `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="text-red-500" viewBox="0 0 16 16">
            <path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06zm7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0z"/>
        </svg>
    `;
}

function updateVideoStatus(element, enabled) {
    element.innerHTML = enabled ? `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="text-white" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2V5z"/>
        </svg>
    ` : `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="text-red-500" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M10.961 12.365a1.99 1.99 0 0 0 .522-1.103l3.11 1.382A1 1 0 0 0 16 11.731V4.269a1 1 0 0 0-1.406-.913l-3.111 1.382A2 2 0 0 0 9.5 3H4.272l6.69 9.365zm-10.114-9A2.001 2.001 0 0 0 0 5v6a2 2 0 0 0 2 2h5.728L.847 3.366zm9.746 11.925-10-14 .814-.58 10 14-.814.58z"/>
        </svg>
    `;
}

// Add this for any other alerts in your code
function showAlert(title, message, type = 'info') {
    return Swal.fire({
        title: title,
        text: message,
        icon: type,
        background: '#1F2937',
        color: '#fff',
        confirmButtonColor: '#3B82F6'
    });
}

// Use this function instead of alert() throughout your code
// Example usage:
// showAlert('Error', 'Something went wrong', 'error');
// showAlert('Success', 'Operation completed', 'success');
// showAlert('Info', 'Please wait...', 'info');