const statuses = ['Delivered', 'Printing', 'Packed', 'Out for delivery', 'Pending', 'Cancelled', 'Refunded'];
const people = ['Aarav Mehta', 'Diya Rao', 'Ishan Kumar', 'Meera Patel', 'Rohan Nair', 'Ananya Shah', 'Kabir Singh', 'Sara Thomas', 'Neha Gupta', 'Vikram Das'];
const regions = ['Main campus', 'North hostel', 'South hostel', 'Engineering block', 'Library'];
export const products = [
  {name:'A4 Black & White', category:'Document printing', price:1.75, stock:1250},
  {name:'A4 Colour', category:'Document printing', price:8.5, stock:420},
  {name:'Spiral binding', category:'Binding', price:35, stock:12},
  {name:'Glossy soft binding', category:'Binding', price:28, stock:8},
  {name:'A3 Colour', category:'Poster printing', price:18, stock:85},
];
export const today = new Date();
today.setHours(23, 59, 59, 999);
// Vary order volume by weekday to resemble demand around campus classes.
const dailyOffsets = Array.from({length:185}, (_, offset) => {
  const date = new Date(today);
  date.setDate(date.getDate() - offset);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  return Array(weekend ? 3 + offset % 4 : 8 + offset % 6).fill(offset);
}).flat();
export const orders = dailyOffsets.map((offset, i) => {
  const product = products[(i * 7 + Math.floor(i / 9)) % products.length];
  const date = new Date(today);
  date.setDate(date.getDate() - offset);
  date.setHours(8 + (i * 7 % 13), i * 19 % 60);
  const status = statuses[[0,0,1,0,2,0,3,0,4,0,0,5,0,0,6,0,0][i % 17]];
  return {id:'PB-' + (16834 - i), customer:i % 4 ? people[(i * 3 + Math.floor(i / 7)) % people.length] : people[i % people.length].split(' ')[0] + ' ' + ['Bose', 'Reddy', 'Menon', 'Joshi', 'Verma', 'Ali', 'Kapoor', 'Iyer', 'Sethi'][Math.floor(i / 8) % 9],
    product:product.name, category:product.category, region:regions[(i * 3 + Math.floor(i / 11)) % regions.length],
    total:Math.round((product.price * (3 + i * 13 % 39) + (i % 3) * 10) * 100) / 100, status, date};
});
export const activity = [
  ['Package dispatched','PB-16828 is out for delivery','8 minutes ago'],
  ['Order received','Diya Rao placed a print order','24 minutes ago'],
  ['Stock running low','Glossy soft binding has 8 units left','1 hour ago'],
  ['Delivery completed','PB-16834 delivered to Main campus','2 hours ago'],
];
export const traffic = [['Direct', 4400], ['Campus referrals', 2900], ['Instagram', 1750], ['Search', 950]];
export const targets = {revenue: 42000, orders: 380, satisfaction: 96};
