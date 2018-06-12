const XSRF_COOKIE_NAME = 'frsx'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  log,
  htmlToPDF,
  createCozyPDFDocument
} = require('cozy-konnector-libs')
const moment = require('moment')
moment.locale('fr')
const URL = require('url').URL
const cookiejar = require('request').jar()
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: cookiejar
})

const baseURL = new URL('https://www.zalando.fr/login/')

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Fetching the list of documents')
  const $ = await request(`${baseURL.origin}/moncompte/commandes/`)
  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['zalando']
  })
}

function parseDocuments($) {
  const docs = scrape(
    $,
    {
      numero: {
        sel: 'td.order span:nth-child(2)'
      },
      amount: {
        sel: 'td.oTotal',
        parse: text => parseFloat(/\d+,\d+/.exec(text)[0].replace(',', '.'))
      },
      date: {
        sel: 'td.date',
        parse: text => moment(text, 'DD/MM/YY').toDate()
      }
    },
    '#myOrdersTable tr.cWrapper'
  )

  return Promise.all(
    docs.map(async doc => ({
      ...doc,
      filename: createFilename(doc),
      filestream: await generatePDF(doc)
    }))
  )
}

function createFilename({ numero, amount }) {
  return `${numero}-${amount}-EUR.pdf`
}

async function generatePDF({ numero }) {
  const url = `https://www.zalando.fr/moncompte/detail-commandes/imprimer/${numero}/`
  const doc = createCozyPDFDocument(
    'Généré automatiquement par le connecteur Le Monde Diplomatique depuis la page',
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
  const loginURL = baseURL.href
  const xsrfToken = await getXsrfToken(loginURL)

  const options = {
    xsrfToken,
    username,
    password,
    url: `${baseURL.origin}/api/reef/login`
  }
  return signin(options)
}

async function signin({ xsrfToken = '', username = '', password = '', url }) {
  const login = await request({
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
    url
  }).catch(err => {
    throw new Error(`Unable to authenticate: ${err}`)
  })
  return login.status
}

function getCookieValue(loginURL) {
  const cookies = cookiejar.getCookies(loginURL)
  return key => {
    const cookie = cookies.find(cookie => cookie.key === key)
    return cookie && cookie['value']
  }
}

async function getXsrfToken(url) {
  await request({
    method: 'GET',
    url
  })

  const xsrfToken = getCookieValue(url)(XSRF_COOKIE_NAME)

  if (!xsrfToken) throw new Error('XSRF cookie has no value')
  return xsrfToken
}
