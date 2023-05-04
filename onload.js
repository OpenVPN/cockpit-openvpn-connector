//  SPDX-License-Identifier: AGPL-3.0-only
//
//  Copyright 2022         OpenVPN Inc <sales@openvpn.net>
//  Copyright 2022         Rohit Kalbag <rohit@openvpn.net>
//  Copyright 2022         Brent Moore <brent.moore@openvpn.net>
//  Copyright 2022         David Sommerseth <davids@openvpn.net>
//

var session_path = undefined; // store the session path that is used by multiple functions
var config_path = undefined;  // store the config path that is used by multiple functions
var versioninfo = undefined;  // store the version so that command is not made on every refresh
var connector_group = false;  // the logged in user is member of the 'connector' group

const default_cloud_cfgname = "CloudConnexa";
const valid_cloud_cfgnames = [ default_cloud_cfgname, "OpenVPNCloud" ]

// D-Bus connection to the session manager; used in most calls
// and keeps the connection for signals sent by the session
// manager and VPN client process
const sesmgr_srv = cockpit.dbus("net.openvpn.v3.sessions");

// Container for various signal subscriptions
const signal_subs = {manager: undefined, session: undefined};

//  Promise object used when the update_connection_stats()
//  is running.  This is used to avoid multiple calls
//  at the same time.
var stats_update_inv = undefined;


// OpenVPN 3 Linux Status constants
class ClientStatus
{
    // This class takes the raw D-Bus result and extracts the
    // components into major and minor status codes, plus
    // handling the optional status message
    constructor(status_arg)
    {
        this.major = status_arg[0];
        this.minor = status_arg[1];
        this.message = status_arg[2];
    }

    // Return the OpenVPN 3 Linux status code/message as a
    // readable string
    toString()
    {
        let ret = this.lookup_major(this.major) + ": " + this.lookup_minor(this.minor);
        if (!(this.major == 2 && this.minor == 2) && this.message && this.message.length > 0)
        {
            // We filter out the "Connection::Connection accepted", as the information there
            // is not useful in the Cockpit UI
            ret += "<br />" + this.message;
        }
        return ret;
    }


    // Check if the received status code is related to
    // an on-going VPN session running or not
    isConnected()
    {
        if (this.major == 2)
        {
            switch (this.minor)
            {
                case 2: return true;  // config ok/accepted
                case 6: return true;  // connecting
                case 7: return true;  // connected
                case 8: return true;  // disconnecting
                case 12: return true; // reconnecting
                case 15: return true; // resuming connectiong
                default: return false;
            }
        }
        return false;
    }


    // Maps a Status Major code into a readable string
    // Major codes are essentially classifing the status event
    // into a group.
    lookup_major(major)
    {
        switch (major)
        {
            case 0: return "[UNSET]";
            case 1: return "Configuration";
            case 2: return "Connection";
            case 3: return "Session";
            case 4: return "PKCS#11";
            case 5: return "Process";
            // Unknown values
            default: return "[UNKNOWN:" + major + "]";
        }
    }


    // Maps Status Minor codes
    lookup_minor(minor)
    {
        switch (minor)
        {
            case 0: return "[UNSET]";
            // Configuration group
            case 1: return "Configuration Error";
            case 2: return "Configuration accepted";
            case 3: return "Configuration Inline Data Missing";
            case 4: return "Configuration Requires User Interaction";
            // Connection group
            case 5: return "Connection Initialized";
            case 6: return "Connecting";
            case 7: return "Connected";
            case 8: return "Disconnecting";
            case 9: return "Disconnected";
            case 10: return "Connection Failed";
            case 11: return "Authentication failed";
            case 12: return "Reconnecting";
            case 13: return "Connection Pausing";
            case 14: return "Connection Paused";
            case 15: return "Connection Resuming";
            case 16: return "Connection done";
            // Session management
            case 17: return "New VPN Session";
            case 18: return "Backend client completed";
            case 19: return "VPN session removed";
            case 20: return "Session awaits username/password authentication";
            case 21: return "Session awaits multi-factor authentication";
            case 22: return "Session awaits web based authentication";
            // PKCS#11 handling (not used by web front-ends; merely for documentation)
            case 23: return "PKCS#11 Signing Request";
            case 24: return "PKCS#11 Encryption Request";
            case 25: return "PKCS#11 Decryption Request";
            case 26: return "PKCS#11 Verify Request";
            // Process management (not used by web front-ends; merely for documentation)
            case 27: return "Process started";
            case 28: return "Process stopped";
            case 29: return "Process killed";
            // Unknown values
            default: return "[UNKNOWN:" + minor + "]";
        }
    }
}


// FIXME: Used in connect logic; should be reworked and removed
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// function to display various DOM sections based on whether connection is running or profile is present
function display_page() {
  // show and hide sections based on profile and session status

  // status indicators
  const config_present = Boolean(config_path != undefined);
  const session_present = Boolean(session_path != undefined);

  // UI elements
  const token_area = document.getElementById("token_area");
  const session_area = document.getElementById("session_area");
  const disconnect_area = document.getElementById("disconnect_area");

  // config present and session present : show session info
  if (Boolean(config_present) && Boolean(session_present)) {
    session_area.style.display = 'block';
    update_connection_stats(); // show statistics of connection
    token_area.style.display = 'none';
    disconnect_area.style.display = 'none';
  }

  // config present and session absent : show disconnected
  if (Boolean(config_present) && !(Boolean(session_present))) {
    session_area.style.display = 'none';
    token_area.style.display = 'none';
    disconnect_area.style.display = 'block';
  }

  // config absent and session absent : show token screen
  if (!(Boolean(config_present)) && !(Boolean(session_present))) {
    session_area.style.display = 'none';
    token_area.style.display = 'block';
    disconnect_area.style.display = 'none';
  }

  // config absent and session present : not possible

  // Change the cursor style to the normal pointer
  document.body.style.cursor = 'default';

  // Close open modals if any exist
  closeAllModals();
}

/// ---- configs-list command processing --------------///
// process to check configuration list and set presence flag and save config path
function check_config_present() {
    const cfgmgr = cockpit.dbus("net.openvpn.v3.configuration");
    cfgmgr.wait(() => {
        try
        {
            // Lookup the config path for a config named "CloudConnexa",
            // which is the config name openvpn-connector-setup uses by default
            //
            // FIXME: Should be able to handle more configs - or at least identify
            //        Cloud configs, regardless of name
            let inv = undefined;
            for (const cfgname of valid_cloud_cfgnames)
            {
                inv = cfgmgr.call("/net/openvpn/v3/configuration", "net.openvpn.v3.configuration",
                                      "LookupConfigName", [cfgname])
                    .then((args) => {
                        if (!config_path)
                        {
                            if (0 == args.length || 0 == args[0].length)
                            {
                                config_path = undefined;
                            }
                            else
                            {
                                config_path = args[0][0]
                                //console.debug("check_config_present() path: " + config_path);
                                display_page();
                            }
                        }
                    })
                    .catch((err) => {
                        error_modal("check_config_present (proxy): ", err);
                    });
            }
            return inv;
        }
        catch (ex)
        {
            error_modal("check_config_present: ", ex);
        }
    });
}


///--- version command processing --------///
function set_openvpn3_version() {
    const version = document.getElementById("version");
    if (versioninfo == undefined)
    {
        // version is not set
        version.innerHTML = "";
        try
        {
            // D-Bus object property values are retrieved from the a D-Bus namespace
            sesmgr_srv.call("/net/openvpn/v3/sessions", "org.freedesktop.DBus.Properties",
                            "Get", ["net.openvpn.v3.sessions", "version"])
                .then((args) => {
                    versioninfo = args[0].v;
                    version.append(document.createTextNode("Version: " + versioninfo));
                })
                .catch((err) => {
                    error_modal("set_openvpn3_version (proxy call): ", err);
                });
        }
        catch (ex)
        {
            error_modal("set_openvpn3_version: ", ex);
        }
    }
    else
    {
        version.append(document.createTextNode(versioninfo));
    }
}


/// --- sessions-list command processing ---///
function check_session_inprogress() {
    try
    {
        // Fetch the VPN session started with the "CloudConnexa" config
        let inv = undefined;
        for (const cfgname of valid_cloud_cfgnames)
        {
            inv = sesmgr_srv.call("/net/openvpn/v3/sessions", "net.openvpn.v3.sessions",
                                      "LookupConfigName", [cfgname])
                .then((args) => {
                    if (!session_path)
                    {
                        // FIXME: This does not account for more sessions started with the same
                        //        configuration name.  It will take the first one.
                        if (0 == args.length || 0 == args[0].length)
                        {
                            session_path = undefined;
                        }
                        else
                        {
                            session_path = args[0][0];
                            //console.debug("check_session_inprogress() path: " + session_path);
                        }
                    }
                })
                .catch((err) => {
                    error_modal("check_session_inprogress (proxy): ", err);
                });
        }
        return inv;
    }
    catch (ex)
    {
        error_modal("check_session_inprogress: ", ex);
    }
}


//  Retrieve session details asynchronoysly.
//  This function returns a Promise and will provide the
//  session status details in to the promise handler.
function get_session_details(path)
{
    if (path)
    {
        // Session details are available through a D-Bus session object property
        // We use the org.freedesktop.DBus.Property.GetAll() method to get all
        // properties in a single call
        let inv = sesmgr_srv.call(path, "org.freedesktop.DBus.Properties",
                                  "GetAll", ["net.openvpn.v3.sessions"])
            .then((args) => {
                if (args.length != 1)
                {
                    error_modal("get_session_details (parsing): Unexpected result<br/><br/> args=", JSON.stringify(args));
                    return;
                }
                let r = args[0];

                let sesd = new Object();
                sesd.status = undefined;
                sesd.session_started = undefined;
                sesd.session_path = path;
                sesd.session_name = undefined;
                sesd.dco = undefined;
                sesd.net_interface = undefined;
                sesd.statistics = undefined;

                // Validate session status data
                if (r.hasOwnProperty("status") && r.status.t == "(uus)" && r.status.v.length == 3)
                {
                    sesd.status = new ClientStatus(r.status.v);
                }
                else
                {
                    error_modal("get_session_details (parsing/status): ", "Unexpected data format");
                    if (r.hasOwnProperty("status"))
                    {
                        console.debug("get_session_details status type=" + r.status.t
                                      + "(length: " + r.status.v.length + ")");
                    }
                    else
                    {
                        error_modal("get_session_details: ", "Status is missing");
                    }
                }

                // Validate session statistics data
                if (r.hasOwnProperty("statistics") && r.statistics.t == "a{sx}")
                {
                    sesd.statistics = r.statistics.v;
                }
                else
                {
                    error_modal("get_session_details (parsing/statistics): ", "Unexpected data format");
                    if (r.hasOwnProperty("statistics"))
                    {
                        console.debug("get_session_details statistics type=" + r.statistics.t);
                    }
                    else
                    {
                        console.debug("get_session_details statistics is missing");
                    }
                }

                // The rest are basic types
                if (r.hasOwnProperty("session_created"))
                {
                    sesd.session_started = new Date(r.session_created.v * 1000);
                }
                if (r.hasOwnProperty("session_name"))
                {
                    sesd.session_name = r.session_name.v;
                }
                if (r.hasOwnProperty("dco"))
                {
                    sesd.dco = r.dco.v;
                }
                if (r.hasOwnProperty("device_name"))
                {
                    sesd.net_interface = r.device_name.v;
                }
                return sesd;
            })
            .catch((err) => {
                if (err.name == "org.freedesktop.DBus.Error.UnknownMethod")
                {
                    console.debug("get_session_details: Session no longer available - " + path);
                    return undefined;
                }
                else
                {
                    error_modal("get_session_details (proxy): ", err);
                    //console.debug("exception: " + JSON.stringify(err));
                    return undefined
                }
            });
        return inv;
    }
    return undefined;
}


/// ----- connected to refresh button ------------///
function update_connection_stats() {
    //check whether session is connected prior to requesting stats

    if (stats_update_inv)
    {
        return;
    }

    const stats_output = document.getElementById("stats_output");
    stats_output.innerHTML = "";

    const status_span = document.getElementById("conn_status");

    try
    {
        stats_update_inv = get_session_details(session_path)
            .then((session_details) => {
                if (session_details == undefined || session_details.status == undefined)
                {
                    status_span.className = "statValue statConnection connected";
                    status_span.innerHTML = "";
                    status_span.appendChild(document.createTextNode("(Unknown connection status)"));
                    return;
                }
                let stats = session_details.statistics;

                // Iterate through all statistics variables
                for (let label in stats)
                {
                    //   // ensure we only extract real objects with values
                    if (typeof(stats[label]) != "undefined")
                    {
                        // Create a div dom element to hold our stat value with the statRow class
                        let div = document.createElement('div');
                        div.className = 'statRow';
                        let span = document.createElement("span");
                        span.className = 'statValue';
                        let statVal =  stats[label];

                        // Beautify & build labels
                        let prettyLabel = labelMap(label);
                        let statLabel = document.createTextNode(prettyLabel);

                        // Build stat values
                        let statValue = document.createTextNode(Number(statVal).toLocaleString()); // Build stat values
                        span.appendChild(statValue); // Wrap values in <span>

                        // Wrap label & value inside of a <div> tag
                        div.appendChild(statLabel);
                        div.appendChild(span);

                        // Update the stats_output
                        stats_output.appendChild(div);
                    }
                }
            })
            .done(() => {
                stats_update_inv = undefined;
            });
    }
    catch(err)
    {
        status_span.className = "statValue statConnection disconnected";
        status_span.innerHTML = "";
        status_span.appendChild(document.createTextNode("ERROR"));
        error_modal("update_connection_stats exception: ", err);
    }
}


function update_connection_status(status)
{
    if (!status || status == undefined)
    {
        return;
    }
    let conn_style = "disconnected";
    if (status.isConnected())
    {
        conn_style = "connected";
    }

    const status_span = document.getElementById("conn_status");
    status_span.className = "statValue statConnection " + conn_style;
    status_span.innerHTML = "";
    status_span.appendChild(document.createTextNode(status.toString()));
}


/// --- token processing on button event ---------------------------///
function use_token() {
    // check that input does not contain any spaces and has length of 84
    const token = document.getElementById("token");

    // FIXME: Should the check be > 83?
    if (token.value.length == 84 && !(token.value.includes(" ")))
    {
        //token is good

        // Should the systemd openvpn3-session@.service unit be enabled?
        const bootstart = document.getElementById("boot_startup");

        // Build up the command line we need
        let cmdline = ["openvpn-connector-setup", "--no-start",
                       "--name", default_cloud_cfgname];

        // Enable data channel offload?
        const dco = document.getElementById("enable_dco");
        if (dco && dco.checked)
        {
            cmdline = cmdline.concat("--dco");
        }

        // Add the Cloud token value
        cmdline = cmdline.concat(["--token", token.value]);

        document.body.style.cursor = 'wait'; // changes cursor to spinning

        // Check if the user is part of the connector group to allow bootstart
        if(!connector_group && bootstart.checked){
            document.body.style.cursor = 'default'; // changes cursor back
            error_modal("User is not a member of the 'connector' user group<br/><br/>", "Unable to configure a connection with Start on boot enabled");

        } else {
            // Display modal
            MicroModal.show('modal-loading');
            document.getElementById("modal_content").innerHTML = "Profile has been downloaded and saved.<br/><br/>Configuring connector, please wait...";

            // Run openvpn-connector-setup
            cockpit.spawn(cmdline)
                .then((data) => {
                    post_cloud_token_install(data, bootstart.checked);
                })
                .catch((err) => {
                    error_modal("use_token: ", err);
                });
        }
    }
    else
    {
        //token is bad
        error_modal("Invalid token format.", "");
    }
}


// This function is called after the openvpn-connector-setup has run
// where it checks if the configuration import happened properly
// and optionally enables this Cloud configuration to be started
// automatically during boot
function post_cloud_token_install(data, enable_boot) {
  if (data.includes("Importing VPN configuration profile")) {
      try
      {
          if (enable_boot)
          {
              systemctl_enable(true).done();
          }
      }
      catch (ex)
      {
          error_modal("Failed enabling the CloudConnexa connection at boot<br/><br/>post_cloud_token_install: ", ex);
      }
      check_config_present()
      check_session_inprogress();
      display_page();
  }
}


function systemctl_enable(enable)
{
    // Enable/Disable the CloudConnexa VPN profile to start during boot.
    let cloud_srv = "openvpn3-session@" + default_cloud_cfgname + ".service";
    const systemd = cockpit.dbus("org.freedesktop.systemd1", { superuser: "try" });
    let inv = undefined;
    if (enable)
    {
        inv = systemd.call("/org/freedesktop/systemd1",
                           "org.freedesktop.systemd1.Manager",
                           "EnableUnitFiles", [[cloud_srv], false, true])
            .catch((err) => {
                error_modal("Failed to start CloudConnexa connection during boot: ", err);
            });
    }
    else
    {
        inv = systemd.call("/org/freedesktop/systemd1",
                           "org.freedesktop.systemd1.Manager",
                           "DisableUnitFiles", [[cloud_srv], false])
            .catch((err) => {
                error_modal("Failed to disable CloudConnexa connection start during boot: ", err);
            });
    }
    return inv;
}


///----- reconnection processing based on click of reconnect button ---///
function start_reconnect() {
    if (session_path)
    {
        try
        {
            // Restart the identified VPN session
            showToast("Reconnecting to CloudConnexa ", "toast-success");
            document.body.style.cursor = 'wait'; // changes cursor to spinning
            sesmgr_srv.call(session_path, "net.openvpn.v3.sessions",
                            "Restart")
                .catch((err) => {
                    error_modal("start_reconnect (proxy): ", err);
                });

            // Hack to enforce getting updated status on reconnects.
            // The session manager does currently not provide the
            // needed signals to trigger a refresh automatically
            sleep(300).then(() => {
                document.body.style.cursor = 'default';
                update_connection_stats();
            });
        }
        catch (ex)
        {
            error_modal("start_reconnect: ", ex);
        }
    }
}


///------ connection processing when connect button is clicked ---///
function start_connection() {
    if (config_path)
    {
        try
        {
            // Start a new VPN tunnel with a known config path
            document.body.style.cursor = 'wait'; // changes cursor to spinning
            // Display modal
            MicroModal.show('modal-loading');
            document.getElementById("modal_content").innerHTML = "Connection starting...";

            // This call just initiates the tunnel session.  The connection
            // itself is started after the session manager sends the "session created"
            // signal, which trigger calling the session_created() function further down.
            sesmgr_srv.call("/net/openvpn/v3/sessions", "net.openvpn.v3.sessions",
                            "NewTunnel", [config_path])
                .then((args) => {
                    // Get a D-Bus proxy connection the new tunnel session
                    if (1 == args.length)
                    {
                        session_path = args[0]
                    }
                })
                .catch((err) => {
                    error_modal("start_connection (mgr proxy): ", err);
                });
        }
        catch (ex)
        {
            error_modal("start_connection: ", ex);
        }
    }
    else
    {
        error_modal("No VPN configuration detected.", "");
    }
}


///---- disconnect processing when disconnect button is clicked -----///
function start_disconnect() {
    if (session_path)
    {
        try
        {
            // Restart the identified VPN session
            document.body.style.cursor = 'wait'; // changes cursor to spinning
            closeAllModals();

            // Display modal
            MicroModal.show('modal-loading');
            document.getElementById("modal_content").innerHTML = "Disconnecting...";

            sesmgr_srv.call(session_path, "net.openvpn.v3.sessions",
                            "Disconnect")
                .catch((err) => {
                    error_modal("start_disconnect (proxy): ", err);
                });
            document.body.style.cursor = 'default';
        }
        catch (ex)
        {
            error_modal("start_disconnect: ", ex);
        }
    }
}


///---- Remove the current config when Remove button is clicked -----///
function start_remove() {
    if (config_path)
    {
        try
        {
            document.body.style.cursor = 'wait'; // changes cursor to spinning
            // Remove the config
            const cfgmgr = cockpit.dbus("net.openvpn.v3.configuration");
            cfgmgr.wait(() => {
                    cfgmgr.call(config_path, "net.openvpn.v3.configuration",
                                "Remove")
                    .then(() => {
                        systemctl_enable(false).done();
                        check_config_present();
                        check_session_inprogress().then(() => {
                            config_path = undefined;
                            document.getElementById('token').value = '';
                            showToast("Profile Successfully Removed", "toast-success");
                            display_page();
                        });
                    })
                    .catch((err) => {
                        error_modal("remove_config (proxy): ", err);
                    });
            });
        }
        catch (ex)
        {
            error_modal("remove_config: ", ex);
        }
    }
}


// Create a map for prettier stat labels
function labelMap(labelItem){
    // Status label translation table
    const labelTranslations = [
        "in=IN",
        "out=OUT",
        "tun=TUN",
        "reconnect=reconnections",
        "kev=keys",
        "expire=expired"
    ];

    // Create a temporary string variable to house a lowercase stat label
    let string = labelItem.toLowerCase();

    // Remove underscore from label
    string = string.replaceAll('_', ' ');

    // Swap 'N' to 'Number of'
    const numRegx = new RegExp('\\b[nN]', 'g');
    string = string.replace(numRegx, "Number of");

    // Replace words with translation table entry
    labelTranslations.forEach((mapString) => {
        const stringArr = mapString.split("=");
        string = string.replace(stringArr[0], stringArr[1]);
    });

    // Return string with first character capitalized
    return string.charAt(0).toUpperCase() + string.slice(1);
}


// Toast alerts
function showToast(msg, toastType) {
    // Get the snackbar DIV
    const toast = document.getElementById("toast");
    toast.innerHTML = msg;

    // Add the "show" class to DIV
    toast.classList.add('show');
    removeClassByPrefix(toast, "toast-");
    toast.classList.add(toastType);

    // After 3 seconds, remove the show class from DIV
    setTimeout(function(){ toast.className = toast.className.replace("show", ""); }, 3000);
}
// Adjust CSS class based on prefix
function removeClassByPrefix(node, prefix) {
	const regx = new RegExp('\\b' + prefix + '[^ ]*[ ]?\\b', 'g');
	node.className = node.className.replace(regx, '');
	return node;
}


// Initialize Modal, and show/hide functionality
function modal_init() {
    try {
      MicroModal.init({
        awaitCloseAnimation: true, // Set to false to remove close animation
        onShow: function(modal) {},
        onClose: function(modal) {}
      });

    } catch (e) {
      console.log("Micromodal error: ", e);
    }
}


// Display a confirmation modal
function confirmation_modal() {
    MicroModal.show('modal-confirm');
}

function config_modal() {
    MicroModal.show('modal-remove');
}

function error_modal(msg, err) {
    closeAllModals();
    MicroModal.show('modal-error');
    document.getElementById("modal_error_content").innerHTML = msg + err;
}


// Close all modals if one exists
// BM TODO - Modify this so modal name can be dynamic
function closeAllModals() {
    try {
        MicroModal.close('modal-loading');
        MicroModal.close('modal-confirm');
        MicroModal.close('modal-remove');
        MicroModal.close('modal-error');
      } catch (e) {
        // console.log("Modal error: ", e);
      }
}


// Show or hide the warning regarding DCO's beta status dependant on whether the option is selected
function show_warning() {
    const checkbox = document.getElementById('enable_dco');
    const alert = document.getElementById('dco_alert');
    const showAlert = checkbox.checked ? 'flex' : 'none';
    alert.style.display = showAlert;
}


// Toggle visibility of the token field value
function show_token() {
    const tokenField = document.getElementById("token");
    // Toggle the type attribute of the token field
    const type = tokenField.getAttribute('type') === 'password' ? 'text' : 'password';
    tokenField.setAttribute('type', type);

    // Adjust the eye icon button state (show/hide)
    const eyeOn = document.getElementById('show_token');
    const eyeOnStyle = window.getComputedStyle(eyeOn);
    eyeOn.style.visibility = eyeOnStyle.getPropertyValue('visibility') === 'visible' ? 'hidden' : 'visible';

    const eyeOff = document.getElementById("hide_token");
    const eyeOffStyle = window.getComputedStyle(eyeOff);
    eyeOff.style.visibility = eyeOffStyle.getPropertyValue('visibility') === 'visible' ? 'hidden' : 'visible';
}


function session_status_chg_handler(path, intf, signame, args)
{
    if (signame == "StatusChange" && path == session_path)
    {
        display_page();

        let status = new ClientStatus(args);
        update_connection_status(status);

        if (status.isConnected())
        {
            sleep(300).then(() => { update_connection_stats() });
            if (status.minor == 7)
            {
                showToast("Connection to CloudConnexa Successful", "toast-success");
                document.body.style.cursor = 'default'; // changes cursor back
                closeAllModals();
            }
            else if (status.minor == 12)
            {
            }
        }
    }
}


function session_created(sesspath, owner)
{
    if (session_path == sesspath)
    {
        // FIXME: Need to look up config name
        display_page();

        // Check if the session is ready to start
        // This implementation does not handle any type of
        // user authentication execpt what is provided in advance
        // in the configuration profile
        sesmgr_srv.call(session_path, "net.openvpn.v3.sessions",
                        "Ready")
            .then((args) => {
                sesmgr_srv.call(session_path, "net.openvpn.v3.sessions",
                                "Connect")
                    .then((args) => {
                        signal_subs.session = sesmgr_srv.subscribe({interface: "net.openvpn.v3.sessions",
                                                                    path: session_path,
                                                                    member: "StatusChange"},
                                                                   session_status_chg_handler);
                        showToast("Connection to CloudConnexa Successful", "toast-success");
                        document.body.style.cursor = 'default'; // changes cursor back
                        closeAllModals();
                        display_page();
                    })
                    .catch((err) => {
                        error_modal("start_connection (session proxy): ", err);
                        session_path = undefined;
                        closeAllModals();
                    });
            })
            .catch((err) => {
                // This can happen (but not limited to) if the profile
                // requires user authentication
                error_modal("start_connection (session proxy): ", err);
                session_path = undefined;
                document.body.style.cursor = 'default'; // changes cursor back
                closeAllModals();
            });
    }
    else if (session_path == undefined)
    {
        check_session_inprogress()
            .then(() => {
                if (session_path == sesspath)
                {
                    if (signal_subs.session)
                    {
                        // We should re-subscribe to signals if we
                        // are already subscribed
                        signal_subs.status.change.remove();
                    }
                    signal_subs.session = sesmgr_srv.subscribe({interface: "net.openvpn.v3.sessions",
                                                                      path: sesspath, member: "StatusChange"},
                                                                     session_status_chg_handler);
                    update_connection_stats();
                    display_page();
                }
                else
                {
                    //console.debug("session_created:  New session started outside of Cockpit, unrelated to Cloud");
                    session_path = undefined;
                }
            });
    }
}


function session_destroyed(sesspath, owner)
{
    if (sesspath != session_path)
    {
        const errorDetails = sesspath + " != " + session_path;
        error_modal("session_destroyed: Incorrect session path - ", errorDetails);
        return;
    }
    if (signal_subs.session)
    {
        signal_subs.session.remove();
        signal_subs.session = undefined;
    }

    showToast("Disconnection Successful", "toast-warning");
    session_path = undefined;
    document.body.style.cursor = 'default'; // changes cursor back

    display_page();
}


function sessionmgr_event(path, interf, signame, args)
{
    if (signame == "SessionManagerEvent")
    {
        switch(args[1])
        {
            case 1: // Session created
                sleep(500).then(() => {session_created(args[0], args[2])});
            break;

            case 2: // Session destroyed
                session_destroyed(args[0], args[2]);
            break;

            default: error_modal("Unexpected SessionManager event: ", JSON.stringify(args));
            break;

        }
    }
}


function connector_ui_init()
{
    let cu = cockpit.user()
    let tooltip_icon = document.getElementById("tooltipContainer");
    let bootstart_checkbox = document.getElementById("boot_startup");

    cu.then((user) => {
        if (user.groups.includes('connector')) {
            connector_group = true;
            tooltip_icon.style.display = 'none';
        } else {
            bootstart_checkbox.checked = false;
            bootstart_checkbox.disabled = true;
            tooltip_icon.style.display = 'block';
        }

        sesmgr_srv.wait(() => {
            // check if profile is present
            set_openvpn3_version();

            // Setup D-Bus signal subscription for session manager events
            signal_subs.manager = sesmgr_srv.subscribe({interface: "net.openvpn.v3.sessions",
                                                        path: "/net/openvpn/v3/sessions",
                                                        member: "SessionManagerEvent"},
                                                    sessionmgr_event);

            // Connect the various buttons to their actor function
            document.getElementById("enable_dco").addEventListener("click", show_warning);
            document.getElementById("show_token").addEventListener("click", show_token);
            document.getElementById("hide_token").addEventListener("click", show_token);
            document.getElementById("submit_token").addEventListener("click", use_token);
            document.getElementById("submit_connect").addEventListener("click", start_connection);
            document.getElementById("submit_refresh").addEventListener("click", update_connection_stats);
            document.getElementById("submit_reconnect").addEventListener("click", start_reconnect);
            document.getElementById("submit_disconnect").addEventListener("click", confirmation_modal);
            document.getElementById("disconnect_confirm").addEventListener("click", start_disconnect);
            document.getElementById("submit_remove").addEventListener("click", config_modal);
            document.getElementById("remove_confirm").addEventListener("click", start_remove);

            check_config_present();
            check_session_inprogress().then(() => {
                display_page();
            });
        });
    });
}

function connector_ui_deinit()
{
    if (singal_subs.manager)
    {
        signal_subs.manager.remove();
    }
}

// to launch function on page load
document.addEventListener('DOMContentLoaded', connector_ui_init);
document.addEventListener('BeforeUnloadEvent', connector_ui_deinit);
document.addEventListener('DOMContentLoaded', modal_init);
