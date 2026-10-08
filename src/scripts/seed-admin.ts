import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../config/mongodb.js';
import { requireEnvironment } from '../config/environment.js';
import { AdminModel } from '../models/AdminSchema.js';

const email = requireEnvironment('ADMIN_EMAIL').trim().toLowerCase();
const password = requireEnvironment('ADMIN_PASSWORD');

try {
  await connectDatabase();
  const passwordHash = await bcrypt.hash(password, 12);
  await AdminModel.findOneAndUpdate(
    { email },
    { $set: { passwordHash, role: 'owner', active: true }, $setOnInsert: { email } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  console.log(`Administrator account is ready for login: ${email}`);
} finally {
  await disconnectDatabase();
}
