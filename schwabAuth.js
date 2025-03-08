require("dotenv").config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const puppeteer = require("puppeteer");

class SchwabAuth {
  constructor() {
    this.authorizationCode = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.takeScreenshots = true;
    
    // Load from .env file
    this.clientId = process.env.CLIENT_ID;
    this.clientSecret = process.env.CLIENT_SECRET;
    this.redirectUri = process.env.REDIRECT_URI;

    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error("Missing required environment variable. See .env.example and README.md for more information.");
    }

    this.app = express();
  }

  startServer() {
    return new Promise((resolve, reject) => {
      const httpsOptions = {
        key: fs.readFileSync("server-key.pem"),
        cert: fs.readFileSync("server-cert.pem"),
      };

      const server = https.createServer(httpsOptions, this.app);

      this.app.get("/", (req, res) => {
        this.authorizationCode = req.query.code;

        if (!this.authorizationCode) {
          return res.status(400).send("Missing authorization code");
        }

        this.getAuthToken()
          .then((tokens) => {
            res.send("Authorization process completed. Check the logs for details.");
            resolve(tokens);
          })
          .catch(reject);
      });

      server.listen(443, () => {
        console.log("Express server is listening on port 443");
      });

      setTimeout(() => {
        if (!this.authorizationCode) {
          console.log("Timeout: No authorization code received. Shutting down the server.");
          server.close(() => resolve(null));
        }
      }, 60000);
    });
  }

  async getAuthToken() {
    const base64Credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    try {
      const response = await axios({
        method: "POST",
        url: "https://api.schwabapi.com/v1/oauth/token",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${base64Credentials}`,
        },
        data: `grant_type=authorization_code&code=${this.authorizationCode}&redirect_uri=${this.redirectUri}`,
      });

      console.log("*** GOT NEW AUTH TOKEN ***");

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      console.log("Access Token:", this.accessToken);
      console.log("Refresh Token:", this.refreshToken);

      return response.data;
    } catch (error) {
      console.error("Error fetching auth token:", error);
      throw error;
    }
  }

  async automateLogin() {
    const browser = await puppeteer.launch({
      headless: false,
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--ignore-certificate-errors",
        "--disable-web-security",
        "--disable-features=SecureDNS,EnableDNSOverHTTPS",
      ],
    });

    const page = await browser.newPage();

    const takeScreenshotIf = async (name) => {
      if (this.takeScreenshots) await page.screenshot({ path: `${name}.png` });
    };

    const waitAndClick = async (selector, description) => {
      await page.waitForSelector(selector, { visible: true });
      console.log(`${description} is visible`);
      await page.click(selector);
      console.log(`Clicked ${description}`);
    };

    const waitForNavAndLog = async (message) => {
      await page.waitForNavigation({ waitUntil: "load" });
      console.log(message);
    };

    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      await page.goto(
        `https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=${this.clientId}&scope=readonly&redirect_uri=${this.redirectUri}`,
        { waitUntil: "load" }
      );
      await takeScreenshotIf("login-page");
      console.log("Navigation to login page successful.");

      await waitAndClick("#loginIdInput", "Login ID input");
      await page.type("#loginIdInput", process.env.LOGIN_ID, { delay: 100 });
      await waitAndClick("#passwordInput", "Password input");
      await page.type("#passwordInput", process.env.PASSWORD, { delay: 100 });
      await takeScreenshotIf("filled-form");
      await waitAndClick("#btnLogin", "Login button");

      await waitForNavAndLog("Navigation to authenticator or terms page successful.");
      await new Promise((resolve) => setTimeout(resolve, 10000));
      
      const currentUrl = page.url();
      console.log("Current URL:", currentUrl);

      if (await page.$("#mobile_approve")) {
        console.log("Detected authenticators page - handling mobile approval");
        await waitAndClick("#mobile_approve", "Mobile approve button");
        await waitAndClick("#remember-device-yes-content", "Remember device option");
        await waitAndClick("text=Continue", "Continue button after remember device");
        
        await waitAndClick("#acceptTerms", "Terms checkbox");
        await waitAndClick("#submit-btn", "Submit button");
        await waitForNavAndLog("Navigation after terms acceptance");
        await waitAndClick("text=Continue", "Final continue button");
        await waitForNavAndLog("Completed mobile authentication step");
      } 
      else if (await page.$("#acceptTerms")) {
        console.log("Detected terms acceptance page - handling terms acceptance");
        
        // Scroll the checkbox into view
        await page.evaluate(() => {
          const checkbox = document.querySelector("#acceptTerms");
          const submitBtn = document.querySelector("#submit-btn");
          
          if (checkbox) {
            checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          if (submitBtn) {
            submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
        
        console.log("Scrolled elements into view");
        
        // Wait for scrolling animation to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        await waitAndClick("#acceptTerms", "Terms checkbox");
        await waitAndClick("#submit-btn", "Submit button");
        await waitAndClick("#agree-modal-btn-", "Modal agree button");
        console.log("Terms accepted successfully.");
      } 
      else {
        console.log("Unknown page type encountered. Taking a screenshot for review.");
        await takeScreenshotIf("unknown-page");
      }

      await waitForNavAndLog("Navigation to accounts page successful.");
      await waitAndClick("input[type='checkbox']", "Account checkbox");
      await takeScreenshotIf("accounts-page");

      const accountsChecked = await page.$eval("input[type='checkbox']", (checkbox) => checkbox.checked);
      if (!accountsChecked) {
        await waitAndClick("input[type='checkbox']", "Account checkbox");
      }
      await takeScreenshotIf("accounts-checked");

      await waitAndClick("#submit-btn", "Continue button on accounts page");
      await waitForNavAndLog("Navigation to confirmation page successful.");
      await takeScreenshotIf("confirmation-page");
      await waitAndClick("#cancel-btn", "Done button");
      await waitForNavAndLog("Redirect to HTTPS server successful.");
      await takeScreenshotIf("final-redirect");

      console.log("Puppeteer automation completed.");
    } catch (error) {
      console.error("Error during automation:", error);
    } finally {
      await browser.close();
    }
  }

  async refreshAuthToken() {
    console.log("*** REFRESHING ACCESS TOKEN ***");

    const base64Credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    try {
      const response = await axios({
        method: "POST",
        url: "https://api.schwabapi.com/v1/oauth/token",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${base64Credentials}`,
        },
        data: `grant_type=refresh_token&refresh_token=${this.refreshToken}`,
      });

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      console.log("New Refresh Token:", response.data.refresh_token);
      console.log("New Access Token:", response.data.access_token);

      return response.data;
    } catch (error) {
      console.error("Error refreshing auth token:", error.response ? error.response.data : error.message);
      throw error;
    }
  }

  async getAccounts() {
    console.log("*** API TEST CALL: ACCOUNTS ***");

    const res = await axios({
      method: "GET",
      url: "https://api.schwabapi.com/trader/v1/accounts?fields=positions",
      contentType: "application/json",
      headers: {
        "Accept-Encoding": "application/json",
        Authorization: "Bearer " + this.accessToken,
      },
    });

    return res.data;
  }

  async init() {
    const serverPromise = this.startServer();
    await this.automateLogin();
    const tokens = await serverPromise;

    if (tokens) {
      console.log("Authorization process completed successfully.");

      // Test api with new accessToken
      await this.getAccounts();

      // Test refreshToken
      await this.refreshAuthToken();

      // Test api with refreshed accessToken
      await this.getAccounts();
    } else {
      console.log("No tokens received within the timeout period.");
    }
  }
}

module.exports = SchwabAuth; 