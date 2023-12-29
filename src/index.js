const LOGIN_URL = 'https://www.zalando.fr/login/'
const XSRF_COOKIE_NAME = 'frsx'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  htmlToPDF,
  createCozyPDFDocument,
  log,
  errors: { LOGIN_FAILED }
} = require('cozy-konnector-libs')
const moment = require('moment')
moment.locale('fr')
const URL = require('url').URL
const jar = require('request').jar()
const request = requestFactory({
  cheerio: true,
  jar,
  debug: true
})

const baseURL = new URL('https://www.zalando.fr')

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Fetching the list of documents')
  const $ = await request(`${baseURL.origin}/moncompte/commandes/`)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    identifiers: ['zalando'],
    contentType: 'application/pdf'
  })
}

function parseDocuments($) {
  const docs = scrape(
    $,
    {
      numero: {
        sel: 'td.order',
        parse: content => content.substr(2)
      },
      date: {
        sel: 'td.date',
        parse: text => moment(text, 'DD/MM/YY').toDate()
      },
      amount: {
        sel: 'td.oTotal',
        parse: normalizePrice
      }
    },
    '#myOrdersTable tr.cWrapper'
  )
  return Promise.all(
    docs.map(async doc => ({
      ...doc,
      filename: createFilename(doc),
      filestream: await generatePDF(doc),
      currency: 'EUR',
      vendor: 'zalando',
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }))
  )
}

async function getXsrfToken() {
  await request({
    jar,
    method: 'GET',
    url: LOGIN_URL,
    headers: {
      Accept: '*/*',
//      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      //      'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:97.0) Gecko/20100101 Firefox/97.0'
      'User-Agent': 'curl/7.68.0'
    }
//    resolveWithFullResponse: true
  })

  const cookiesList = jar.getCookies(LOGIN_URL)

  const xsrfToken = getCookieValue(cookiesList, XSRF_COOKIE_NAME)
  if (!xsrfToken) {
    log('error', 'XSFR token was not found in cookies')
    throw new Error(LOGIN_FAILED)
  }
  return xsrfToken
}

async function generatePDF({ numero }) {
  const url = `${baseURL.origin}/moncompte/detail-commandes/imprimer/${numero}/`
  const doc = createCozyPDFDocument(
    'Généré automatiquement par le connecteur Zalando depuis la page',
    url
  )
  const $ = await request(url)
  htmlToPDF($, doc, $('.printPage'), {
    baseURL: url
  })
  doc.end()
  return doc
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  const xsrfToken = await getXsrfToken()
  const options = {
    xsrfToken,
    username,
    password,
    url: `${baseURL.origin}/api/reef/login`,
    validate: () => true
  }

  try {
    await signin(options)
  } catch (err) {
    if (err.statusCode === 401) throw new Error(LOGIN_FAILED)
    else throw err
  }
}

async function signin({ xsrfToken, username, password, url, validate }) {
  const req = require('request-promise')
  const response = await req({
    jar,
    headers: {
      'x-xsrf-token': xsrfToken,
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: {
      username,
      password,
      wnaMode: 'shop'
    },
    json: true,
    method: 'POST',
    uri: url,
    resolveWithFullResponse: true
  })
  return validate(response)
}

// convert a price string to a float
function normalizePrice(text) {
  return parseFloat(/\d+,\d+/.exec(text)[0].replace(',', '.'))
}

function createFilename({ numero, amount, date }) {
  return `${moment(date).format('YYYYMMDD')}-${numero}-${amount}-EUR.pdf`
}

function findCookie(cookies) {
  return searchedKey => cookies.find(({ key }) => key === searchedKey)
}

function getCookieValue(cookies, key) {
  const { value } = findCookie(cookies)(key)
  return value
}
