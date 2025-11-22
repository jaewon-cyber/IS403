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
        password : "admin1234",
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
//         database : process.env.DB_NAME || "studygroup",
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



// Dashboard Page
app.get("/", async (req, res) => {
  try {
    let firstName = "Student";
    let isStudentUser = false;

    if (req.session.userId) {
      const student = await knex("students")
        .where("student_id", req.session.userId)
        .first();

      if (student) {
        firstName = student.stud_first_name;
      } else if (req.session.username) {
        firstName = req.session.username;
      }
    }

    // Compare the displayed firstName to "Student" (case-insensitive)
    if (firstName.toLowerCase() === "student") {
      isStudentUser = true;
    }

    res.render("index", {
      firstName,
      isStudentUser,
      userId: req.session.userId
    });

  } catch (err) {
    console.error("Dashboard Error:", err);

    res.render("index", {
      firstName: "Student",
      isStudentUser: true // fallback: treat default "Student" as the placeholder user
    });
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
// GET /editProfile - show profile + grouped, scrollable course list
// POST /editProfile - update student info and enrolled courses
// GET /editProfile - show profile + grouped, scrollable course list
// GET /editProfile - show profile with current classes and subjects for add
app.get("/editProfile", isAuthenticated, async (req, res) => {
  try {
    const studentId = req.session.userId;

    // 1) fetch student info
    const student = await knex("students")
      .where("student_id", studentId)
      .first();

    // 2) fetch subjects for dropdown (subject_id, subject_code, subject_name)
    const subjects = await knex("subjects")
      .select("subject_id", "subject_code", "subject_name")
      .orderBy("subject_code");

    // 3) fetch the student's current classes (join courses -> subjects for readable display)
    const studentClasses = await knex("student_schedules as ss")
      .leftJoin("courses as c", "ss.course_id", "c.course_id")
      .leftJoin("subjects as s", "c.subject_id", "s.subject_id")
      .where("ss.student_id", studentId)
      .select(
        "c.course_id",
        "c.course_number",
        "c.semester",
        "c.year",
        "s.subject_code",
        "s.subject_name"
      )
      .orderBy("c.year", "desc")
      .orderByRaw(`
        CASE WHEN c.semester = 'Fall' THEN 4
             WHEN c.semester = 'Winter' THEN 3
             WHEN c.semester = 'Spring' THEN 2
             WHEN c.semester = 'Summer' THEN 1
             ELSE 0 END DESC
      `);

    // 4) render
    res.render("editProfile", {
      student,
      subjects,
      studentClasses
    });
  } catch (err) {
    console.error("GET /editProfile error:", err);
    res.status(500).send("Server Error");
  }
});


// POST /editProfile - update info, remove selected classes, and optionally add a new course
app.post("/editProfile", isAuthenticated, async (req, res) => {
  const studentId = req.session.userId;

  try {
    // 1) Safe update of student personal info (avoid empty update)
    const updateData = {
      stud_first_name: req.body.stud_first_name,
      stud_last_name: req.body.stud_last_name,
      stud_email: req.body.stud_email,
      stud_phone_number: req.body.stud_phone_number,
      stud_gender: req.body.stud_gender,
      stud_age: req.body.stud_age
    };

    // Remove undefined or empty strings
    Object.keys(updateData).forEach(k => {
      if (updateData[k] === undefined || updateData[k] === "") delete updateData[k];
    });

    if (Object.keys(updateData).length > 0) {
      await knex("students").where("student_id", studentId).update(updateData);
    }

    // Start a transaction to handle removals and additions atomically
    await knex.transaction(async trx => {
      // 2) Handle removals: checkboxes named 'remove_courses'
      let toRemove = req.body.remove_courses || [];
      if (!Array.isArray(toRemove)) toRemove = [toRemove];
      toRemove = toRemove.map(Number).filter(Boolean);

      if (toRemove.length > 0) {
        await trx("student_schedules")
          .where("student_id", studentId)
          .whereIn("course_id", toRemove)
          .del();
      }

      // 3) Handle adding a new course if add_course fields are present
      const add_subject_id = req.body.add_subject_id ? Number(req.body.add_subject_id) : null;
      const add_course_number = (req.body.add_course_number || "").toString().trim();
      const add_semester = (req.body.add_semester || "").toString().trim();
      const add_year = req.body.add_year ? parseInt(req.body.add_year, 10) : null;

      const validAdd = add_subject_id && add_course_number && add_semester && add_year;

      if (validAdd) {
        // 3a) Check if the exact course already exists
        let existingCourse = await trx("courses")
          .where({
            subject_id: add_subject_id,
            course_number: add_course_number,
            semester: add_semester,
            year: add_year
          })
          .first();

        let courseId;
        if (existingCourse) {
          courseId = existingCourse.course_id;
        } else {
          // 3b) Insert new course and get its id (Postgres returns first)
          const [inserted] = await trx("courses")
            .insert({
              subject_id: add_subject_id,
              course_number: add_course_number,
              semester: add_semester,
              year: add_year
            })
            .returning("course_id"); // returns array with inserted row's course_id

          // depending on knex/pg version, inserted might be number or object
          courseId = typeof inserted === "object" ? inserted.course_id : inserted;
        }

        // 3c) Link the course to the student if not already linked
        const alreadyLinked = await trx("student_schedules")
          .where({ student_id: studentId, course_id: courseId })
          .first();

        if (!alreadyLinked) {
          await trx("student_schedules").insert({
            student_id: studentId,
            course_id: courseId
          });
        }
      } // end validAdd
    }); // end transaction

    // Done
    res.redirect("/profile");
  } catch (err) {
    console.error("POST /editProfile error:", err);
    // If you want to surface validation to the user, render the form with an error message instead.
    res.status(500).send("Server Error");
  }
});


// =========================================
// CREATE PROFILE (GET)
// Renders the "Create Profile" form page.
// =========================================
app.get("/createProfile", async (req, res) => {
  try {
    // Load all available subjects from DB for the subject dropdown
    const subjects = await knex("subjects").select("*");

    // Render the form with no error message
    res.render("createProfile", { subjects, error: null });

  } catch (err) {
    console.error("Error loading profile creation:", err);
    res.status(500).send("Server error");
  }
});


// =========================================
// CREATE PROFILE (POST)
// Handles form submission for creating a new user.
// Validates input → inserts student → inserts credentials
// → optionally inserts a course → logs user in.
// =========================================
app.post("/createProfile", async (req, res) => {
  try {
    // Extract submitted form fields
    const {
      stud_first_name,
      stud_last_name,
      stud_phone_number,
      stud_email,
      stud_gender,
      stud_age,
      username,
      password,
      password_confirm,
      add_subject_id,
      add_semester,
      add_year,
      add_course_number
    } = req.body;

    // Load subjects again (needed if form must re-render after an error)
    const subjects = await knex("subjects").select("*");

    // -----------------------------
    // VALIDATION: Password length
    // -----------------------------
    if (!password || password.length < 8) {
      return res.render("createProfile", {
        subjects,
        error: "Password must be at least 8 characters long."
      });
    }

    // -----------------------------
    // VALIDATION: Password match
    // -----------------------------
    if (password !== password_confirm) {
      return res.render("createProfile", {
        subjects,
        error: "Passwords do not match."
      });
    }

    // -----------------------------
    // VALIDATION: Username taken?
    // -----------------------------
    const existingUser = await knex("credentials")
      .where({ username })
      .first();

    if (existingUser) {
      return res.render("createProfile", {
        subjects,
        error: "That username is already taken."
      });
    }

    // -----------------------------
    // INSERT: Student record
    // -----------------------------
    const insertedStudent = await knex("students")
      .insert({
        stud_first_name,
        stud_last_name,
        stud_phone_number,
        stud_email,
        stud_gender,
        stud_age
      })
      .returning("student_id");  // Returns array: [{ student_id: X }]

    const studentId = insertedStudent[0].student_id;

    // -----------------------------
    // INSERT: Login credentials
    // ties credentials to student_id
    // -----------------------------
    await knex("credentials").insert({
      student_id: studentId,
      username,
      password
    });

    // -----------------------------
    // OPTIONAL: Insert course + schedule
    // Only runs if the user provided a subject + course number
    // -----------------------------
    if (add_subject_id && add_course_number) {
      const insertedCourse = await knex("courses")
        .insert({
          subject_id: add_subject_id,
          course_number: add_course_number,
          semester: add_semester,
          year: add_year
        })
        .returning("course_id");

      const courseId = insertedCourse[0].course_id;

      // Connect student to course
      await knex("student_schedules").insert({
        student_id: studentId,
        course_id: courseId
      });
    }

    // -----------------------------
    // LOG IN THE NEW USER
    // Store data in session
    // -----------------------------
    req.session.userId = studentId;
    req.session.username = username;

    // Redirect to home page
    res.redirect("/");

  } catch (err) {
    console.error("Create Profile Error:", err);
    res.status(500).send("Server error");
  }
});


// =========================================
// DELETE USER
// Removes:
// 1. Student schedule entries
// 2. Credentials (login)
// 3. Student profile
// Uses a transaction to ensure all-or-nothing delete.
// Then logs the user out and redirects to login.
// =========================================
app.post("/deleteUser", isAuthenticated, async (req, res) => {
  const studentId = req.session.userId;

  try {
    // Use a transaction to safely delete related records
    await knex.transaction(async trx => {

      // Remove schedule records tied to this student
      await trx("student_schedules")
        .where({ student_id: studentId })
        .del();

      // Remove login credentials
      await trx("credentials")
        .where({ student_id: studentId })
        .del();

      // Remove main student record
      await trx("students")
        .where({ student_id: studentId })
        .del();
    });

    // After deleting data, destroy the session so the user is logged out
    req.session.destroy(() => {
      res.redirect("/login"); // Send user back to login page
    });

  } catch (err) {
    console.error("Delete User Error:", err);
    res.status(500).send("Error deleting user.");
  }
});



app.listen(3000, () => console.log("The server is listening for a client."));