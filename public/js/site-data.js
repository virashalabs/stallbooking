// Company details, taken from the official site https://autoexposuburban.com/
export const COMPANY = {
  name: 'AUTO EXPO SUBURBAN EVENTS',
  since: 2009,
  sister: 'PRIME GEAR EVENTS',
  tagline: "Chennai's Premier Corporate Event Planner",
  intro: 'Expertise in automotive events and corporate functions.',
  about: 'At Auto Expo Suburban, we pride ourselves on our extensive experience in automotive BTL activities. Our team ensures that every event is tailored to meet the unique needs of our clients, delivering exceptional results.',
  points: [
    'Personalized service tailored to your unique needs.',
    'Experienced professionals dedicated to your success.',
    'Proven results that speak for themselves.',
  ],
  address: 'Nanganallur, Chennai, TN 600061',
  mapUrl: 'https://www.google.com/maps/search/?api=1&query=Nanganallur%2C+Chennai%2C+TN+600061',
  phones: ['9841517136', '9840049879'],
  upi: 'autoexposuburban-1@oksbi',
  whatsapp: '919840049879',
  hours: 'Mon – Sun · 09:00 am – 05:00 pm',
  website: 'https://autoexposuburban.com/',
};

export const VENUES = [
  ['01.png', 'LTIMindtree'], ['02.png', 'Rattha'], ['03.png', 'Tamarai Tech Park'],
  ['04.png', 'Mahindra World City'], ['05.png', 'Embassy Office Parks'], ['06.png', 'TIDEL Park'],
  ['07.jpg', 'Millenia Business Park'], ['08.png', 'RMZ'], ['09.png', 'Mindtree'],
  ['10.png', 'Larsen & Toubro · Mindtree'], ['11.png', 'World Trade Center'], ['12.png', 'CapitaLand'],
  ['13.png', 'Intellion · Tata Realty'],
].map(([f, name]) => ({ src: `/img/venues/${f}`, name }));

export const PATRONS = [
  ['05.png', 'Mercedes-Benz'], ['03.png', 'Maruti Suzuki'], ['13.png', 'Hyundai'], ['14.jpg', 'Toyota'],
  ['18.png', 'Honda'], ['06.png', 'Kia'], ['12.jpg', 'Mahindra'], ['17.png', 'Tata Motors'],
  ['16.png', 'MG'], ['15.png', 'Nexa'], ['04.jpg', 'BYD'], ['08.jpg', 'Volkswagen'],
  ['09.png', 'Citroën'], ['10.png', 'Nissan'], ['11.png', 'Renault'], ['07.png', 'Harley-Davidson'],
  ['20.png', 'Ola'], ['01.png', 'Casagrand'], ['02.png', 'Arun Excello'], ['21.png', 'Akshaya'],
  ['22.png', 'Baashyaam'], ['23.png', 'Urban Tree'], ['24.png', 'PS Group'], ['25.jpg', 'Isha Homes'],
  ['27.png', 'Indiabulls Home Loans'], ['26.jpg', 'Indiabulls Property Show'], ['28.png', 'Doshi Housing'],
  ['33.png', 'KG Builders'], ['34.png', 'DRA Homes'], ['35.png', 'Shriram Properties'], ['36.png', 'SIS'],
  ['29.png', 'The Hindu'], ['30.png', 'Daily Thanthi'], ['31.jpg', 'Hello FM 106.4'], ['32.jpg', 'Big FM 92.7'],
  ['19.png', 'Patron'],
].map(([f, name]) => ({ src: `/img/patrons/${f}`, name }));

export const POSTERS = ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg'].map(f => `/img/posters/${f}`);
