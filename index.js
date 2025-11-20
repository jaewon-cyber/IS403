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

// Dashboard Page (Requires Authentication)
//app.get("/", isAuthenticated, (req, res) => {
    // Pass the username to the index.ejs template for a personalized welcome
    //res.render("index", { username: req.session.username });
//});

app.get("/", isAuthenticated, async (req, res) => {
    try {
        // Look up the logged-in student's first name
        const student = await knex("students")
            .where("student_id", req.session.userId)
            .select("stud_first_name")
            .first();

        res.render("index", { firstName: student.stud_first_name });
    } catch (error) {
        console.error("Error fetching first name:", error);

        // Fallback in case of issue
        res.render("index", { firstName: "Student" });
    }
});

// Render Login Page
app.get("/login", (req, res) => {
    // Retrieve and clear any error messages from the session
    const error = req.session.error;
    req.session.error = null;
    res.render("login", { error: error });
});

// Handle Login Attempt
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

// Display Users Page (Requires Authentication)

app.get("/displayUsers", isAuthenticated, async (req, res) => {
    try {
        const loggedInStudentId = req.session.userId;
        const search = req.query.search?.trim() || "";

        // Base query - display all users except the current student
        let query = knex("students as s")
            .whereNot("s.student_id", loggedInStudentId)
            .leftJoin("student_schedules as ss", "s.student_id", "ss.student_id")
            .leftJoin("courses as c", "ss.course_id", "c.course_id")
            .leftJoin("subjects as sub", "c.subject_id", "sub.subject_id")
            .select(
                "s.student_id",
                "s.stud_first_name",
                "s.stud_last_name",
                "s.stud_phone_number",
                "s.stud_email",
                "sub.subject_code",
                "c.course_number",
                "c.semester",
                "c.year"
            );

        // SEARCH LOGIC (works with subject code, combination of subject code and course number
        // multi-word subjects and course number combinations and spacing)
        if (search !== "") {
            let normalized = search.replace(/\s+/g, " ").toUpperCase().trim();
            const tokens = normalized.split(" ");
            const lastToken = tokens[tokens.length - 1];

            if (/^\d+$/.test(lastToken)) {
                // Last token is a number - like course_number
                const courseNumber = tokens.pop();
                const subjectCode = tokens.join(" ").replace(/\s+/g, "");

                query
                    .whereRaw("REPLACE(UPPER(sub.subject_code), ' ', '') LIKE ?", [`${subjectCode}%`])
                    .andWhereILike("c.course_number", `${courseNumber}%`);
            } else {
                // Last token is not a number - search performed with only subject code
                const subjectCode = normalized.replace(/\s+/g, "");
                query.whereRaw("REPLACE(UPPER(sub.subject_code), ' ', '') LIKE ?", [`${subjectCode}%`]);
            }
        }

        const rows = await query.orderBy("s.student_id", "asc");

        // GROUPING LOGIC
        const studentsMap = {};

        rows.forEach(row => {
            if (!studentsMap[row.student_id]) {
                studentsMap[row.student_id] = {
                    student_id: row.student_id,
                    first_name: row.stud_first_name,
                    last_name: row.stud_last_name,
                    phone: row.stud_phone_number,
                    email: row.stud_email,
                    courses: []
                };
            }

            if (row.subject_code && row.course_number) {
                studentsMap[row.student_id].courses.push({
                    subject_code: row.subject_code,
                    course_number: row.course_number,
                    semester: row.semester,
                    year: row.year
                });
            }
        });

        let students = Object.values(studentsMap);

        // Hide students with no matching courses when searching
        if (search !== "") {
            students = students.filter(s => s.courses.length > 0);
        }

        // COURSE SORTING (Most recent semester first, then alphabetical by subject_code)
        const semesterOrder = {
            "Fall": 4,
            "Winter": 3,
            "Spring": 2,
            "Summer": 1
        };

        function getCourseScore(course) {
            return course.year * 10 + semesterOrder[course.semester];
        }

        function sortCourses(a, b) {
            const scoreA = getCourseScore(a);
            const scoreB = getCourseScore(b);

            // Newest first
            if (scoreB !== scoreA) return scoreB - scoreA;

            // Tie-breaker: alphabetical by subject_code
            if (a.subject_code < b.subject_code) return -1;
            if (a.subject_code > b.subject_code) return 1;
            return 0;
        }

        students.forEach(student => {
            if (student.courses) {
                student.courses.sort(sortCourses);
            }
        });

        // render displayUsers with search input
        res.render("displayUsers", { students, search });

    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).send("Server Error");
    }
});


// Create Profile Page (Requires Authentication)
app.get("/createProfile", isAuthenticated, (req, res) => {
    res.render("createProfile")
});

// Logout Handler
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