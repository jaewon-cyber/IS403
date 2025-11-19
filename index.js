require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;
const session = require("express-session");

app.use(
    session(
        {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
        }
    )
);

const knex = require("knex")({
    client: "pg",
    connection: {
        host : "localhost",
        user : "postgres",
        password : "admin",
        database : "users",
        port : 5432
    }
});

app.get("/", (req, res) => {
    res.render("index")
})

app.get("/join-group", (req, res) => {
    res.render("join-group")
})

app.get("/create-group", (req, res) => {
    res.render("create-group")
})

app.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if(err){
            console.log(err);
        }
        else {
            res.redirect("/");
        }
    });
});



app.listen(3000, () => console.log("The server is listening for a client."));
