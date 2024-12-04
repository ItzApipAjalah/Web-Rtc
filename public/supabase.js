// Initialize Supabase client
const supabaseUrl = 'https://cmpqwyzlzgmkwkrngztx.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtcHF3eXpsemdta3drcm5nenR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjQ1MTAzNzcsImV4cCI6MjA0MDA4NjM3N30.AcB3YQgIaF3aulOf6hG7qgjr0KBXQ-Anj3y_2ZuMfJg';
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

async function signUp(email, password, username) {
    try {
        // First check if username is available
        const { data: existingUser, error: checkError } = await supabaseClient
            .from('profiles')
            .select('username')
            .eq('username', username)
            .single();

        if (existingUser) {
            throw new Error('Username already taken');
        }

        // If username is available, proceed with signup
        const { data, error } = await supabaseClient.auth.signUp({
            email: email,
            password: password,
            options: {
                data: {
                    username: username
                }
            }
        });
        
        if (error) throw error;
        return { data, error: null };
    } catch (error) {
        console.error('Error signing up:', error.message);
        return { data: null, error: error.message };
    }
}

async function signIn(email, password) {
    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password,
        });
        
        if (error) throw error;

        // Fetch user profile after successful login
        const { data: profile, error: profileError } = await supabaseClient
            .from('profiles')
            .select('username')
            .eq('id', data.user.id)
            .single();

        if (profileError) throw profileError;

        return { data: { ...data, profile }, error: null };
    } catch (error) {
        console.error('Error signing in:', error.message);
        return { data: null, error: error.message };
    }
}

async function signOut() {
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
        return { error: null };
    } catch (error) {
        console.error('Error signing out:', error.message);
        return { error: error.message };
    }
}

async function getCurrentUser() {
    try {
        const { data: { user }, error } = await supabaseClient.auth.getUser();
        if (error) throw error;

        if (user) {
            // Fetch user profile
            const { data: profile, error: profileError } = await supabaseClient
                .from('profiles')
                .select('username')
                .eq('id', user.id)
                .single();

            if (profileError) throw profileError;
            return { user: { ...user, profile }, error: null };
        }

        return { user: null, error: null };
    } catch (error) {
        console.error('Error getting user:', error.message);
        return { user: null, error: error.message };
    }
}

async function updateUsername(userId, newUsername) {
    try {
        const { data, error } = await supabaseClient
            .from('profiles')
            .update({ username: newUsername, updated_at: new Date() })
            .eq('id', userId);

        if (error) throw error;
        return { data, error: null };
    } catch (error) {
        console.error('Error updating username:', error.message);
        return { data: null, error: error.message };
    }
}

// Make functions available globally
window.signUp = signUp;
window.signIn = signIn;
window.signOut = signOut;
window.getCurrentUser = getCurrentUser;
window.updateUsername = updateUsername;