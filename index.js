const express = require('express');
const session = require('express-session');
const redis = require('redis');
const connectRedis = require('connect-redis');
const bodyParser = require('body-parser');
const mysql = require("mysql2");
const { v4: uuidv4 } = require('uuid'); // Benzersiz kimlik oluşturmak için
const amqp = require('amqplib/callback_api'); //rabbitmq için
const mongoose = require('mongoose');//mongodb için

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
        console.error('MySQL bağlanti hatasi: ' + err);
    } else {
        console.log('MySQL bağlantısı başarılı.');
    }
});

const redisClient = redis.createClient({
    host: 'redis_container',
    port: 6379
});

redisClient.on('error', function (err) {
    console.log('Could not establish a connection with redis. ' + err);
});
redisClient.on('connect', function (err) {
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

// Benzersiz kullanıcı kimliği oluşturmak için fonksiyon
function generateUniqueId() {
    return uuidv4(); // UUID kullanarak benzersiz bir kimlik oluştur
}

app.get("/", (req,res)=>{
    res.send("hello world");
});

app.get("/profile", (req,res)=>{
    const session = req.session;
    if(session.username) {
        res.send("Welcome");
        return;
    }
    res.sendStatus(401);
});


app.post("/register", (req, res) => {
    const { username, password } = req.body;
    const userId = generateUniqueId(); // Benzersiz bir ID oluşturulur
    connection.query('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [userId, username, password], (error, results, fields) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
            return;
        }
        res.status(201).send("User registered successfully");
    });
});



app.post("/login", (req, res) => {
    const session = req.session;
    const { username, password } = req.body;
    connection.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (error, results, fields) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.send("An error occurred while processing your request");
            return;
        }
        if (results.length > 0) {
            const userId = results[0].id; // Kullanıcının ID'si alınır
            session.userId = userId; // Oturum verisine kullanıcı ID'si eklenir
            res.send("Login successful");
        } else {
            // Kayıtlı kullanıcı bulunamadı, kullanıcıyı kayıt olma sayfasına yönlendir
            res.redirect("/register");
        }
    });
});



app.get("/logout",(req,res)=>{
    req.session.destroy((err)=>{
        if(err) {
            console.error('Session destroy error: ', err);
            res.send("An error occurred while processing your request");
            return;
        }
        res.send("Logout successful");
    });
});


// Middleware oluşturma
function checkLoggedIn(req, res, next) {
    // Oturum bilgilerini kontrol et
    if (req.session.userId) {
        // Kullanıcı giriş yapmışsa, bir sonraki middleware'e geç
        next();
    } else {
        // Kullanıcı giriş yapmamışsa, erişimi reddet
        res.status(401).send("Unauthorized");
    }
} 


//Ürünler İçin EndPointler

// Ürünleri listeleme endpoint'i
app.get("/products", checkLoggedIn, (req, res) => {
    const userId = req.session.userId; // Oturumda kayıtlı kullanıcı kimliği
    connection.query('SELECT * FROM products WHERE user_id = ?', [userId], (error, results, fields) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
            return;
        }
        res.json(results);
    });
});
// Yeni bir ürün eklemek için POST endpoint'i
app.post("/products", checkLoggedIn, (req, res) => {
    const { name, price, description } = req.body;
    const userId = req.session.userId; // Oturumda kayıtlı kullanıcı kimliği
    connection.query('INSERT INTO products (name, price, description, user_id) VALUES (?, ?, ?, ?)', [name, price, description, userId], (error, results, fields) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
            return;
        }
        res.status(201).send("Product added successfully");
    });
});

// Belirli bir ürünü güncellemek için PUT endpoint'i
app.put("/products/:id", checkLoggedIn, (req, res) => {
    const productId = req.params.id;
    const { name, price, description } = req.body;
    connection.query('UPDATE products SET name = ?, price = ?, description = ? WHERE id = ?', [name, price, description, productId], (error, results, fields) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
            return;
        }
        res.send("Product updated successfully");
    });
});

// Belirli bir ürünü silmek için DELETE endpoint'i
app.delete("/products/:id", checkLoggedIn, (req, res) => {
    const productId = req.params.id;
    connection.query('DELETE FROM products WHERE id = ?', [productId], (error, results, fields) => {
        if (error) {
            console.error('MySQL query error: ', error);
            res.status(500).send("An error occurred while processing your request");
            return;
        }
        res.send("Product deleted successfully");
    });
});


// RabbitMQ connection
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
                
                // RabbitMQ bağlantısı başarıyla kurulduktan sonra order işlemlerini gerçekleştir
                // order creation
                app.post("/orders", (req, res) => {
                    const { items, user_id, total } = req.body;

                    // Insert order into MySQL
                    connection.query('INSERT INTO orders (items, user_id, total) VALUES (?, ?, ?)', [items, user_id, total], (error, results, fields) => {
                        if (error) {
                            console.error('MySQL query error: ', error);
                            res.status(500).send("An error occurred while processing your request");
                            return;
                        }

                        // Publish order to RabbitMQ
                        const order = { items, user_id, total };
                        channel.assertQueue('order_queue', { durable: true });
                        channel.sendToQueue('order_queue', Buffer.from(JSON.stringify(order)), { persistent: true });

                        res.status(201).send("Order created successfully");
                    });
                });
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
                // Gelen mesajı işle
                console.log('Received message:', msg.content.toString());
                // Mesajı işlediğinizde kuyruktan kaldırın
                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error('Error while listening to the queue: ', error);
        throw error;
    }
};

// Kuyruğu dinlemeye başla
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

                // Kuyruğu dinlemeye başla
                listenQueue(channel);
            }
        });
    }
});
const consumeOrderQueue = () => {
    channel.consume('order_queue', async (msg) => {
        const order = JSON.parse(msg.content.toString());
        console.log('Received order:', order);

        // Siparişteki her bir ürün için stoktan düşüş işlemini gerçekleştir
        for (const item of order.items) {
            await decreaseProductStock(item.productId, item.quantity);
        }

        // Siparişin işlendiğini doğrulamak için RabbitMQ'ya ACK gönder
        channel.ack(msg);
    });
};
//Stoktan ürün düşüşü İşlemi
const decreaseProductStock = async (productId, quantity) => {
    try {
        // Ürün stok miktarını azalt
        await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [quantity, productId]);
        console.log(`Stock decreased for product ${productId} by ${quantity}`);
    } catch (error) {
        console.error('Error while decreasing product stock:', error);
        throw error;
    }
};
// Ürün yorumları kısmı 


// MongoDB bağlantısı
mongoose.connect('mongodb://mongo:27017/my_database', { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB bağlantısı başarılı'))
  .catch((err) => console.error('MongoDB bağlantı hatası:', err));

// MongoDB Schema (Model) tanımı
const CommentSchema = new mongoose.Schema({
  orderId: String,
  userId: String,
  content: String,
  rating: Number
});

// MongoDB Modeli
const Comment = mongoose.model('Comment', CommentSchema);

// Middleware - JSON verilerini işleme
app.use(express.json());

// Yorum ekleme endpoint'i
app.post('/comments', async (req, res) => {
  const { orderId, userId, content, rating } = req.body;
  
  try {
    // Yeni yorum oluştur
    const comment = new Comment({ orderId, userId, content, rating });
    await comment.save();
    res.status(201).send('Yorum başarıyla eklendi');
  } catch (err) {
    console.error('Yorum ekleme hatası:', err);
    res.status(500).send('Yorum eklenirken bir hata oluştu');
  }
});

// Tüm yorumları getiren endpoint
app.get('/comments', async (req, res) => {
  try {
    const comments = await Comment.find();
    res.json(comments);
  } catch (err) {
    console.error('Yorumlar getirme hatası:', err);
    res.status(500).send('Yorumlar getirilirken bir hata oluştu');
  }
});



app.listen(3000,()=>{
    console.log("server is running on port 3000");
});
