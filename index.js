require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;
const session = require("express-session");

// Session configuration
app.use(
    session(
        {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
        }
    )
);

// Knex PostgreSQL database configuration
const knex = require("knex")({
    client: "pg",
    connection: {
        host : "localhost",
        user : "postgres",
        password : "admin",
        database : "studygroup",
        port : 5432
    }
});

// Authentication Middleware to protect routes
const isAuthenticated = (req, res, next) => {
    // Check if the user ID is present in the session
    if (req.session.userId) {
        next(); // User is logged in, proceed to the next handler/route
    } else {
        // User is not logged in, redirect to login page with an error
        req.session.error = "Please log in to view the dashboard.";
        res.redirect("/login");
    }
};

// --- Route Definitions ---

// ➡️ Dashboard Page (Requires Authentication)
app.get("/", isAuthenticated, (req, res) => {
    // Pass the username to the index.ejs template for a personalized welcome
    res.render("index", { username: req.session.username });
});

// ➡️ Render Login Page
app.get("/login", (req, res) => {
    // Retrieve and clear any error messages from the session
    const error = req.session.error;
    req.session.error = null;
    res.render("login", { error: error });
});

// ➡️ Handle Login Attempt
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    try {
        // Find the user in the 'credentials' table using both username and plaintext password
        const user = await knex('credentials')
            .where({
                username: username,
                password: password // Plaintext password comparison
            })
            .select('student_id', 'username')
            .first(); // Retrieve only the first matching user
        
        if (user) {
            // Authentication successful
            req.session.userId = user.student_id;   // Store student_id in session
            req.session.username = user.username; // Store username in session
            res.redirect("/"); // Redirect to the main dashboard
        } else {
            // Authentication failed
            req.session.error = "Invalid username or password.";
            res.redirect("/login");
        }
    } catch (err) {
        console.error("Login Error:", err);
        req.session.error = "An unexpected error occurred during login.";
        res.redirect("/login");
    }
});

// ➡️ Join Group Page (Requires Authentication)
app.get("/displayUsers", isAuthenticated, (req, res) => {
    res.render("displayUsers")
});

// ➡️ Create Group Page (Requires Authentication)
app.get("/createProfile", isAuthenticated, (req, res) => {
    res.render("createProfile")
});

// ➡️ Logout Handler
app.get("/logout", (req, res) => {
    // Destroy the session
    req.session.destroy((err) => {
        if(err){
            console.log(err);
        }
        else {
            // Redirect to the login page after logout
            res.redirect("/login"); // FIX: Redirect to /login
        }
    });
});

app.listen(3000, () => console.log("The server is listening for a client."));