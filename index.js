const express = require('express');
const session = require('express-session');
const redis = require('redis');
const connectRedis = require('connect-redis');
const bodyParser = require('body-parser');
const mysql = require("mysql2");
const { v4: uuidv4 } = require('uuid');
const amqp = require('amqplib/callback_api');
const mongoose = require('mongoose');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const RedisStore = connectRedis(session);

const connection = mysql.createPool({
    connectionLimit: 100,
    host: "mysql",
    user: "root",
    port: "3306",
    password: "root",
    database: "records"
});

connection.getConnection((err, connection) => {
    if (err) {
        console.error('MySQL bağlantı hatası: ' + err);
    } else {
        console.log('MySQL bağlantısı başarılı.');
    }
});

const redisClient = redis.createClient({
    host: 'redis_container',
    port: 6379
});

redisClient.on('error', (err) => {
    console.log('Could not establish a connection with redis. ' + err);
});

redisClient.on('connect', () => {
    console.log('Connected to redis successfully');
});

app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: 'secret$%^134',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: false,
        maxAge: 1000 * 60 * 10
    }
}));

function generateUniqueId() {
    return uuidv4();
}

app.get("/", (req, res) => {
    res.send("hello world");
});

app.get("/profile", (req, res) => {
    const session = req.session;
    if (session.username) {
        res.send("Welcome");
    } else {
        res.sendStatus(401);
    }
});

app.post("/register", (req, res) => {
    const { username, password } = req.body;
    const userId = generateUniqueId();
    connection.query('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [userId, username, password], (error) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
        } else {
            res.status(201).send("User registered successfully");
        }
    });
});

app.post("/login", (req, res) => {
    const session = req.session;
    const { username, password } = req.body;
    connection.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (error, results) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.send("An error occurred while processing your request");
        } else if (results.length > 0) {
            const userId = results[0].id;
            session.userId = userId;
            res.send("Login successful");
        } else {
            res.redirect("/register");
        }
    });
});

app.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error: ', err);
            res.send("An error occurred while processing your request");
        } else {
            res.send("Logout successful");
        }
    });
});

function checkLoggedIn(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        res.status(401).send("Unauthorized");
    }
}

app.get("/products", checkLoggedIn, (req, res) => {
    const userId = req.session.userId;
    connection.query('SELECT * FROM products WHERE user_id = ?', [userId], (error, results) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
        } else {
            res.json(results);
        }
    });
});

app.post("/products", checkLoggedIn, (req, res) => {
    const { name, price, description } = req.body;
    const userId = req.session.userId;
    connection.query('INSERT INTO products (name, price, description, user_id) VALUES (?, ?, ?, ?)', [name, price, description, userId], (error) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
        } else {
            res.status(201).send("Product added successfully");
        }
    });
});

app.put("/products/:id", checkLoggedIn, (req, res) => {
    const productId = req.params.id;
    const { name, price, description } = req.body;
    connection.query('UPDATE products SET name = ?, price = ?, description = ? WHERE id = ?', [name, price, description, productId], (error) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
        } else {
            res.send("Product updated successfully");
        }
    });
});

app.delete("/products/:id", checkLoggedIn, (req, res) => {
    const productId = req.params.id;
    connection.query('DELETE FROM products WHERE id = ?', [productId], (error) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
        } else {
            res.send("Product deleted successfully");
        }
    });
});

let channel = null;
amqp.connect('amqp://rabbitmq', (err, conn) => {
    if (err) {
        console.error('RabbitMQ connection error: ', err);
    } else {
        conn.createChannel((err, ch) => {
            if (err) {
                console.error('RabbitMQ channel creation error: ', err);
            } else {
                channel = ch;
                console.log('Connected to RabbitMQ successfully');

                app.post("/orders", (req, res) => {
                    const { items, user_id, total } = req.body;
                    connection.query('INSERT INTO orders (items, user_id, total) VALUES (?, ?, ?)', [items, user_id, total], (error) => {
                        if (error) {
                            console.error('MySQL query error: ', error);
                            res.status(500).send("An error occurred while processing your request");
                        } else {
                            const order = { items, user_id, total };
                            channel.assertQueue('order_queue', { durable: true });
                            channel.sendToQueue('order_queue', Buffer.from(JSON.stringify(order)), { persistent: true });
                            res.status(201).send("Order created successfully");
                        }
                    });
                });

                listenQueue(channel);
            }
        });
    }
});

const listenQueue = async (channel) => {
    try {
        const queue = 'order_queue';
        await channel.assertQueue(queue, { durable: true });
        console.log(`Worker is listening to the queue: ${queue}`);
        channel.consume(queue, (msg) => {
            if (msg !== null) {
                console.log('Received message:', msg.content.toString());
                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error('Error while listening to the queue: ', error);
        throw error;
    }
};

const decreaseProductStock = async (productId, quantity) => {
    try {
        await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [quantity, productId]);
        console.log(`Stock decreased for product ${productId} by ${quantity}`);
    } catch (error) {
        console.error('Error while decreasing product stock:', error);
        throw error;
    }
};

const consumeOrderQueue = () => {
    channel.consume('order_queue', async (msg) => {
        const order = JSON.parse(msg.content.toString());
        console.log('Received order:', order);

        for (const item of order.items) {
            await decreaseProductStock(item.productId, item.quantity);
        }

        channel.ack(msg);
    });
};

mongoose.connect('mongodb://root:password@mongo:27017/my_database?authSource=admin')
  .then(() => console.log('MongoDB bağlantısı başarılı'))
  .catch((err) => console.error('MongoDB bağlantı hatası:', err));

const CommentSchema = new mongoose.Schema({
    orderId: {
        type: String,
        required: true
    },
    userId: {
        type: String,
        required: true
    },
    content: {
        type: String,
        required: true
    },
    rating: {
        type: Number,
        required: true
    }
});

const Comment = mongoose.model('Comment', CommentSchema);

app.use(express.json());

app.post('/comments', async (req, res) => {
    const { orderId, userId, content, rating } = req.body;

    try {
        const comment = new Comment({ orderId, userId, content, rating });
        await comment.save();
        res.status(201).send('Yorum başarıyla eklendi');
    } catch (err) {
        console.error('Yorum ekleme hatası:', err);
        res.status(500).send('Yorum eklenirken bir hata oluştu');
    }
});

app.get('/comments', async (req, res) => {
    try {
        const comments = await Comment.find();
        res.json(comments);
    } catch (err) {
        console.error('Yorumlar getirme hatası:', err);
        res.status(500).send('Yorumlar getirilirken bir hata oluştu');
    }
});

app.listen(3000, () => {
    console.log("server is running on port 3000");
});
