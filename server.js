const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- RUTA USUARIOS ---
app.get('/api/usuarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM usuarios ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/usuarios', async (req, res) => {
  const { nombre, presupuesto_maximo } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, presupuesto_maximo) VALUES ($1, $2) RETURNING *',
      [nombre, presupuesto_maximo || 1000.00]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/usuarios/:id/presupuesto', async (req, res) => {
  const { id } = req.params;
  const { presupuesto_maximo } = req.body;
  try {
    const result = await pool.query(
      'UPDATE usuarios SET presupuesto_maximo = $1 WHERE id = $2 RETURNING *',
      [presupuesto_maximo, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    res.json({ message: 'Usuario y registros eliminados exitosamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUTA CATÁLOGO ---
app.get('/api/catalogo', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM catalogo ORDER BY categoria, nombre ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NUEVO: Agregar producto al catálogo general
app.post('/api/catalogo', async (req, res) => {
  const { nombre, categoria, icono } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO catalogo (nombre, categoria, icono) VALUES ($1, $2, $3) RETURNING *',
      [nombre, categoria, icono]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUTA CARRITO / LISTA ---
app.get('/api/lista/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM lista_compras WHERE usuario_id = $1 ORDER BY id DESC',
      [usuario_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lista', async (req, res) => {
  const { usuario_id, nombre, categoria, icono, precio_mxn, cantidad, unidad } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO lista_compras (usuario_id, nombre, categoria, icono, precio_mxn, cantidad, unidad) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [usuario_id, nombre, categoria, icono, precio_mxn, cantidad || 1, unidad || 'pzas']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lista/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM lista_compras WHERE id = $1', [id]);
    res.json({ message: 'Eliminado del carrito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FINALIZAR COMPRA (Transacción para Historial) ---
app.post('/api/compras/finalizar', async (req, res) => {
  const { usuario_id, total } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const cartRes = await client.query('SELECT * FROM lista_compras WHERE usuario_id = $1', [usuario_id]);
    const cartItems = cartRes.rows;

    if (cartItems.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El carrito está vacío' });
    }

    const histRes = await client.query(
      'INSERT INTO historial_compras (usuario_id, total) VALUES ($1, $2) RETURNING id',
      [usuario_id, total]
    );
    const historialId = histRes.rows[0].id;

    for (const item of cartItems) {
      await client.query(
        'INSERT INTO historial_detalles (historial_id, nombre, categoria, icono, precio_mxn, cantidad, unidad) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [historialId, item.nombre, item.categoria, item.icono, item.precio_mxn, item.cantidad, item.unidad]
      );
    }

    await client.query('DELETE FROM lista_compras WHERE usuario_id = $1', [usuario_id]);

    await client.query('COMMIT');
    res.json({ message: 'Compra finalizada exitosamente', historialId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- RUTA HISTORIAL ---
app.get('/api/historial/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;
  try {
    const query = `
      SELECT 
        h.id, 
        h.fecha, 
        h.total,
        COALESCE(
          json_agg(
            json_build_object(
              'nombre', d.nombre,
              'icono', d.icono,
              'precio_mxn', d.precio_mxn,
              'cantidad', d.cantidad,
              'unidad', d.unidad
            )
          ) FILTER (WHERE d.id IS NOT NULL), '[]'
        ) AS items
      FROM historial_compras h
      LEFT JOIN historial_detalles d ON h.id = d.historial_id
      WHERE h.usuario_id = $1
      GROUP BY h.id
      ORDER BY h.fecha DESC
    `;
    const result = await pool.query(query, [usuario_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NUEVO: Eliminar un registro del historial (CASCADE borra sus detalles automáticamente)
app.delete('/api/historial/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM historial_compras WHERE id = $1', [id]);
    res.json({ message: 'Compra borrada del historial' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Backend activo en el puerto ${PORT}`));