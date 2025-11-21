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

// Ryan: I had to use this method to query from the database
// const knex = require("knex")({
//     client: "pg",
//     connection: {
//         host : process.env.DB_HOST || "localhost",
//         user : process.env.DB_USER || "postgres",
//         password : process.env.DB_PASSWORD || "admin1234",
//         database : process.env.DB_NAME || "foodisus",
//         port : process.env.DB_PORT || 5432  // PostgreSQL 16 typically uses port 5434
//     }
// });

// Authentication Middleware to protect routes
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next(); 
    } else {
        res.redirect("/login");
    }
};

// --- Route Definitions ---



// ➡️ Dashboard Page
app.get("/", isAuthenticated, async (req, res) => {
    try {
        
        const studentId = req.session.userId;

        
        const student = await knex("students")
            .where("student_id", studentId)
            .first();

        const firstName = student ? student.stud_first_name : req.session.username;

        res.render("index", { firstName: firstName });

    } catch (err) {
        console.error("Dashboard Error:", err);
        res.render("index", { firstName: "Student" }); 
    }
});


// Render Login Page
app.get("/login", (req, res) => {
    const error = req.session.error || null; 
    req.session.error = null; 
    res.render("login", { error: error });
});

//  Handle Login Attempt
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await knex('credentials')
            .where({
                username: username,
                password: password
            })
            .select('student_id', 'username')
            .first(); 
        
        if (user) {
            req.session.userId = user.student_id;   
            req.session.username = user.username; 
            
            
            req.session.save(() => {
                res.redirect("/"); 
            });
        } else {
            
            req.session.error = "Invalid username or password.";
            
            
            req.session.save(() => {
                res.redirect("/login");
            });
        }
    } catch (err) {
        console.error("Login Error:", err);
        req.session.error = "An unexpected error occurred during login.";
        req.session.save(() => {
            res.redirect("/login");
        });
    }
});

// Display Users Page (Requires Authentication)
// test
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


//Ryan's profile pages 
// ==========================
// PROFILE PAGE ROUTE
// ==========================
app.get("/profile", isAuthenticated, async (req, res) => {
    try {
        const studentId = req.session.userId; // Get logged-in student's ID from session

        // Fetch student personal information
        const student = await knex("students")
            .where("student_id", studentId)
            .first();

        // Fetch student's enrolled courses, joined with subjects
        const classes = await knex("student_schedules as ss")
            .leftJoin("courses as c", "ss.course_id", "c.course_id")
            .leftJoin("subjects as sub", "c.subject_id", "sub.subject_id")
            .where("ss.student_id", studentId)
            .select(
                "sub.subject_code",
                "c.course_number",
                "c.semester",
                "c.year"
            )
            .orderBy("c.year", "desc")
            .orderByRaw(`
                CASE 
                    WHEN c.semester = 'Fall' THEN 4
                    WHEN c.semester = 'Winter' THEN 3
                    WHEN c.semester = 'Spring' THEN 2
                    WHEN c.semester = 'Summer' THEN 1
                END DESC
            `); // Sort courses newest first, by semester

        // Render profile page with student info and classes
        res.render("profilePage", { student, classes });

    } catch (err) {
        console.error("Profile fetch error:", err);
        res.status(500).send("Error loading profile.");
    }
});

// ==========================
// EDIT PROFILE (GET) - Display the form
// ==========================
app.get("/editProfile", isAuthenticated, async (req, res) => {
  try {
    const studentId = req.session.userId;

    // Fetch student info
    const student = await knex("students")
      .where("student_id", studentId)
      .first();

    // Fetch all courses for selection
    const allCourses = await knex("courses as c")
      .leftJoin("subjects as s", "c.subject_id", "s.subject_id")
      .select(
        "c.course_id",
        "s.subject_code",
        "c.course_number",
        "c.semester",
        "c.year"
      )
      .orderBy("c.year", "desc");

    // Fetch current student's enrolled courses
    const studentCourses = await knex("student_schedules")
      .where("student_id", studentId)
      .pluck("course_id"); // returns array of course IDs

    // Render edit profile page with student info, all courses, and current selections
    res.render("editProfile", {
      student,
      allCourses,
      studentCoursesIds: studentCourses
    });

  } catch (err) {
    console.error("Error loading edit page:", err);
    res.status(500).send("Server Error");
  }
});

// ==========================
// EDIT PROFILE (POST) - Save changes
// ==========================
app.post("/editProfile", isAuthenticated, async (req, res) => {
  const studentId = req.session.userId;

  try {
    // Prepare student info update data
    const updateData = {
      stud_first_name: req.body.stud_first_name,
      stud_last_name: req.body.stud_last_name,
      stud_email: req.body.stud_email,
      stud_phone_number: req.body.stud_phone_number,
      stud_gender: req.body.stud_gender,
      stud_age: req.body.stud_age
    };

    // Remove any undefined or empty fields to prevent empty update errors
    for (const key in updateData) {
      if (!updateData[key]) delete updateData[key];
    }

    // Update student info if there is something to update
    if (Object.keys(updateData).length > 0) {
      await knex("students").where("student_id", studentId).update(updateData);
    }

    // ==========================
    // Handle course selection
    // ==========================
    let selectedCourses = req.body.courses || [];
    if (!Array.isArray(selectedCourses)) selectedCourses = [selectedCourses]; // Ensure array
    selectedCourses = selectedCourses.map(Number); // Convert IDs to integers

    // Delete old enrollments
    await knex("student_schedules").where("student_id", studentId).del();

    // Insert new enrollments
    if (selectedCourses.length > 0) {
      const inserts = selectedCourses.map(courseId => ({
        student_id: studentId,
        course_id: courseId
      }));
      await knex("student_schedules").insert(inserts);
    }

    res.redirect("/profile"); // Go back to profile page after saving

  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).send("Server Error");
  }
});

// ==========================
// EDIT COURSES (GET) - Scrollable course list
// ==========================
app.get("/editCourses", isAuthenticated, async (req, res) => {
  try {
    const studentId = req.session.userId;

    // Get the student's current courses
    const studentCourses = await knex("student_schedules")
      .where("student_id", studentId)
      .pluck("course_id");

    // Get all courses for display in a scrollable box
    const allCourses = await knex("courses as c")
      .leftJoin("subjects as s", "c.subject_id", "s.subject_id")
      .select(
        "c.course_id",
        "s.subject_code",
        "c.course_number",
        "c.semester",
        "c.year"
      )
      .orderBy("c.year", "desc");

    // Render the edit courses page
    res.render("editCourses", {
      studentCoursesIds: studentCourses,
      allCourses
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// ==========================
// EDIT COURSES (POST) - Save selected courses
// ==========================
app.post("/editCourses", isAuthenticated, async (req, res) => {
  try {
    const studentId = req.session.userId;

    // Ensure courses are an array of integers
    let selectedCourses = req.body.courses || [];
    if (!Array.isArray(selectedCourses)) selectedCourses = [selectedCourses];
    selectedCourses = selectedCourses.map(Number);

    // Delete all previous enrollments
    await knex("student_schedules").where("student_id", studentId).del();

    // Insert new selections
    if (selectedCourses.length > 0) {
      const inserts = selectedCourses.map(course_id => ({
        student_id: studentId,
        course_id
      }));
      await knex("student_schedules").insert(inserts);
    }

    res.redirect("/profile"); // Back to profile page
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});


app.listen(3000, () => console.log("The server is listening for a client."));