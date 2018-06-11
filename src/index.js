const LOGIN_URL = 'https://www.zalando.fr/login/'
const XSRF_COOKIE_NAME = 'frsx'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  saveFiles,
  log
} = require("cozy-konnector-libs");
const cheerio = require('cheerio');
const pdf = require('pdfjs')
const html2pdf = require('./html2pdf')
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
});

const jar = request.jar()

const baseUrl = "https://www.zalando.fr";

module.exports = new BaseKonnector(start);

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log("info", "Authenticating ...");
  await authenticate(fields.login, fields.password);
  log("info", "Successfully logged in");
  // The BaseKonnector instance expects a Promise as return of the function
  // log('info', 'Fetching the list of documents')
  // const $ = await request(`${baseUrl}/index.html`)
  // // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  // log('info', 'Parsing list of documents')
  // const documents = await parseDocuments($)
  //
  // // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // // common case in connectors
  // log('info', 'Saving data to Cozy')
  // await saveBills(documents, fields.folderPath, {
  //   // this is a bank identifier which will be used to link bills to bank operations. These
  //   // identifiers should be at least a word found in the title of a bank operation related to this
  //   // bill. It is not case sensitive.
  //   identifiers: ['books']
  // })
}

function getCookieValue(cookiesString, cookieName) {
  const cookieString = RegExp(`${cookieName}[^;]+`).exec(cookiesString)
  // Return everything after the equal sign, or an empty string if the cookie name not found
  return decodeURIComponent(!!cookieString ? cookieString.toString().replace(/^[^=]+./,'') : '')
}

async function getXsrfToken() {

  const loginPage = await request({
    jar,
    method: 'GET',
    url: LOGIN_URL,
    resolveWithFullResponse: true
  })

  const cookiesString = jar.getCookies(LOGIN_URL)

  const xsrfToken = getCookieValue(cookiesString, XSRF_COOKIE_NAME)
  if (!xsrfToken) throw new Error('XSRF cookie has no value')
  return xsrfToken
}

async function retrievePDF(order) {
  const url = `https://www.zalando.fr/moncompte/detail-commandes/imprimer/${order.orderId}/`
  const orderPage = await request({
    jar,
    url,
    method: 'GET'
  })

  const $orderPage = cheerio.load(orderPage)
  $orderPage('#oderOverview td').first().removeAttr('colspan')

  var doc = new pdf.Document()
  const cell = doc.cell({ paddingBottom: 0.5 * pdf.cm }).text()
  cell.add('Généré automatiquement par le connecteur Zalando depuis la page ', {
    font: require('pdfjs/font/Helvetica-Bold'),
    fontSize: 14
  })
  cell.add(url, {
    link: url,
    color: '0x0000FF'
  })
  html2pdf($orderPage, doc, $orderPage('#content'), { baseURL: 'https://www.zalando.fr' })
  doc.end()
  return doc
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  const xsrfToken = await getXsrfToken()
  const loginResponse = await request({
    jar,
    headers: {
      'x-xsrf-token': xsrfToken,
      'accept': 'application/json',
      'content-type': 'application/json'
    },
    body: {
      username,
      password,
      'wnaMode': 'shop'
    },
    json: true,
    method: 'POST',
    url: 'https://www.zalando.fr/api/reef/login',
    resolveWithFullResponse: false
  })

  const data = await request({
    jar,
    method: 'GET',
    url: 'https://www.zalando.fr/moncompte/commandes/1/'
  })

  const $accountPage = cheerio.load(data)

  const orders = scrape($accountPage, {
    commandNum: {
      sel: 'td.order',
      parse: (content) => content.substr(2)
    },
    date: {
      sel: 'td.date'
    },
    total: {
      sel: 'td.oTotal',
      parse: normalizePrice
    },
    isPaid: {
      sel: 'td.statusPayment',
      parse: (content) => content.indexOf('Réglé') !== -1 ? true : false
    },
    isShipped: {
      sel: 'td.statusShipping',
      parse: (content) => content.indexOf('Envoyée') !== -1 ? true : false
    },
    orderId: {
      sel: 'td.nextStep a',
      attr: 'href',
      parse: (content) => content.match(/\d+/g)
    }

  }, '#myOrdersTable tbody tr.cWrapper')

  const pdfBills = Promise.all(orders.map(retrievePDF))
  return await saveBills(pdfBills, 'test', {
    identifiers: ['zalando'],
    contentType: 'application/pdf'
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/cozy/cozy-konnector-libs/blob/master/docs/api.md#savebills)
function parseDocuments($) {
  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      title: {
        sel: "h3 a",
        attr: "title"
      },
      amount: {
        sel: ".price_color",
        parse: normalizePrice
      },
      url: {
        sel: "h3 a",
        attr: "title",
        parse: url => `${baseUrl}/${url}`
      },
      fileurl: {
        sel: "img",
        attr: "src",
        parse: src => `${baseUrl}/${src}`
      },
      filename: {
        sel: "h3 a",
        attr: "title",
        parse: title => `${title}.jpg`
      }
    },
    "article"
  );
  return docs.map(doc => ({
    ...doc,
    // the saveBills function needs a date field
    // even if it is a little artificial here (these are not real bills)
    date: new Date(),
    currency: "€",
    vendor: "template",
    metadata: {
      // it can be interesting that we add the date of import. This is not mandatory but may be
      // usefull for debugging or data migration
      importDate: new Date(),
      // document version, usefull for migration after change of document structure
      version: 1
    }
  }));
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.trim().replace("€", "").trim().replace(',', '.'));
}
