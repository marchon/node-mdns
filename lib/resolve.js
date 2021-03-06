/** @file
 *
 *  A resolution client capable of performing queries to either a traditional
 *  unicast DNS server or as an mDNS client.
 *
 */
var Util        = require('util'),
    Events      = require('events'),
    Net         = require('net'),
    Dgram       = require('dgram'),
    Utils       = require('./utils.js'),
    Pack        = require('./pack.js').Pack,
    Mdns        = require('./mdns.js');

/** @brief  Create a new Resolve instance.
 *  @param  config  If provided, an instance configuration object:
 *                      question    A Question instance, configuration object,
 *                                  array of instances or array of
 *                                  configuration objects;
 *                      server      If this client will query a traditional
 *                                  unicast DNS server, this object specifies
 *                                  server information:
 *                                      address the IP address of the server;
 *                                      port        the port of the server
 *                                                  [ 53 ];
 *                                      proto       which IP protocol to use
 *                                                  ( 'udp' | 'tcp' )
 *                                                  [ 'udp' ];
 *                      timeout     Query timeout (in micro-seconds)
 *                                  ( 0 == no timeout ) [ 6000 ];
 *
 *
 *  @emits  response  records, rinfo, response-message, raw-data (for mDNS 0+)
 *          end
 *          timeout
 *          error     Error instance
 *          listening (for mDNS multi-cast queries)
 */
function Resolve(config)
{
    var self    = this;

    Events.EventEmitter.call(self);


    config = config || {};

    self.question = null;
    self.server   = null;
    self.timeout  = (config.timeout === undefined
                        ? 6000
                        : config.timeout);

    if (config.server)
    {
        self.server = { address: null, port: 53, proto: 'udp' };

        if (typeof config.server === 'string')
        {
            self.server.address = config.server;
        }
        else
        {
            self.server.address = config.server.address;
            self.server.port    = config.server.port  | self.server.port;
            self.server.proto   = config.server.proto | self.server.proto;

            if ((self.server.proto !== 'tcp') && (self.server.proto !== 'udp'))
            {
                self.server.proto = 'udp';
            }
        }
    }

    if (config.question)
    {
        if (! Array.isArray(config.question))
        {
            config.question = [ config.question ];
        }

        self.question = [];

        config.question.forEach(function(qConfig) {
            var question    = qConfig;
            if (! Mdns.isQuestion(question))
            {
                question = Mdns.Question(qConfig);
            }

            self.question.push(question);
        });
    }
}
Util.inherits(Resolve, Events.EventEmitter);

/** @brief  Begin a resolution.
 *
 *  @return true | Error instance;
 */
Resolve.prototype.begin = function() {
    var self    = this,
        isMdns  = (! self.server ),
        proto   = (self.server && (self.server.proto === 'tcp')
                    ? 'tcp'
                    : 'udp');

    if ( (! isMdns) && ((! self.question) ||
                        (self.question && (self.question.length < 1))) )
    {
        return new Error("Missing 'question'");
    }

    self._requests  = [];
    self._records   = [];
    self._rinfos    = [];
    self._responses = [];
    self._data      = [];

    if (self.question && (self.question.length > 0))
    {
        /*********************************************************************
         * Generate 1 request for each incoming question
         *
         */
        var bufSize = Mdns.config.bufSize[proto];

        self.question.forEach(function(question) {
            var request = {
                    id:     self._requests.length,
                    isMdns: isMdns,
                    // Signal Recursion Desired (RD)
                    msg:    Mdns.Message({
                                header:   {rd:1},
                                question: question
                            }),
                    pack:   new Pack( new Buffer( bufSize ) )
                };

            if (! request.msg.pack( request.pack ))
            {
                // :XXX: Packing error...
                self.emit('error', new Error('Internal packing error: '
                                            + request.pack.error));
                return;
            }

            self._requests.push( request );
        });

        if (self._requests.length < 0)
        {
            return self.end();
        }
    }

    if (self.timeout > 0)
    {
        /*********************************************************************
         * If a timeout was specified as non-zero, create a timeout timer
         *
         */
        self._timer  = setTimeout(function() {
                            self.emit('timeout');
                            self.end();
                       }, self.timeout);
    }

    if (isMdns && (self._requests.length === 0))
    {
        // Create a pseudo-request indicating no question but mDNS
        self._requests.push( { id:0, isMdns: true } );
    }

    self._requests.forEach(function(request) {
        switch (proto)
        {
        case 'udp':
            _udp(self, request);
            break;

        case 'tcp':
            _tcp(self, request);
            break;
        }
    });

    return true;
};

/** @brief  End a resolution.
 *  @param  request     The triggering request (if any).
 */
Resolve.prototype.end   = function(request) {
    var self    = this;

    if (request)
    {
        var sock    = request.socket;
        if (sock)
        {
            sock.removeAllListeners();
            sock.close();
        }

        self._requests[ request.id ] = null;

        delete request.pack;
        delete request.msg;

        // Are there any active requests remaining?
        var finished    = true;
        self._requests.forEach(function(req) {
            if (req !== null)   { finished = false; }
        });

        if (finished !== true)
        {
            return;
        }
    }

    // All requests have completed
    if (self._timer)    { clearTimeout(self._timer); }
    delete self._timer;

    if (self._records.length > 0)
    {
        self.emit('response', self._records,
                              self._rinfos,
                              self._responses,
                              self._data);
    }

    self.emit('end');
};

module.exports = Resolve;



/**********************************************************************
 * Private helpers and utilities
 *
 */

/** @brief  Handle a UDP DNS resolution.
 *  @param  self    The Resolve instance;
 *  @param  request The request object:
 *                      { id:, isMdns:, msg:, pack: }
 *
 */
function _udp(self, request)
{
    var bindings    = {
            'error':    function(e) {
                self.emit('error', e);
            },
            'close':    function() {
                self.end( request );
            },
            'message':  function(msg, rinfo) {
                var response    = _processResponse(self, request, msg, rinfo);

                if (! request.isMdns)
                {
                    /* Uni-cast queery expects a SINGLE response
                     *  (unless the response was truncated)
                     */
                    if (response.header.tc === 0)
                    {
                        return self.end( request );
                    }
                }
            }
        },
        addr, port;

    if (! request.isMdns)
    {
        // normal, DNS uni-cast query
        addr = self.server.address;
        port = self.server.port;

        request.socket = Dgram.createSocket('udp4');
        for (var name in bindings)
        {
            var binding = bindings[name];

            request.socket.on(name, binding);
        }

        sendPacket();
    }
    else
    {
        // mDNS multi-cast query
        addr = Mdns.config.ipv4;
        port = Mdns.config.port;

        bindings['listening'] = function() {
            var ainfo   = request.socket.address();

            self.emit('listening', ainfo);

            sendPacket();
        };

        request.socket = Mdns.socket('udp4', bindings);
    }

    function sendPacket()
    {
        if (! request.pack) { return; }

        // Send the request
        var buf     = request.pack.buf,
            offset  = request.pack.begin,
            length  = request.pack.offset - offset;

        // /*
        console.log("request to %s:%s:\n%s\n%s",
                    addr, port,
                    request.msg,
                    Utils.buf2hex(buf, {
                        offset:     offset,
                        length:     length,
                        octetsPer:  16,
                        ascii:      true}));
        // */
        request.socket.send( buf, offset, length, port, addr );
    }
}

/** @brief  Handle a TCP DNS resolution.
 *  @param  self    The Resolve instance;
 *  @param  request The request object:
 *                      { id:, msg:, pack: }
 *
 */
function _tcp(self, request)
{
    request.socket = Net.connect(self.server.port, self.server.address);

    request.socket.on('connect', function() {
    });

    request.socket.on('timeout', function() {
        self.end( request );
    });

    request.socket.on('error', function(e) {
        self.emit('error', e);
    });

    request.socket.on('close', function() {
        self.end( request );
    });

    request.socket.on('data', function(data) {
    });

    // :XXX: Send the question
}

/** @brief  Process a DNS response packet.
 *  @param  self    The Resolve instance;
 *  @param  request The request object:
 *                      { id:, isMdns:, msg:, pack: }
 *  @param  data    The raw DNS packet data (Buffer);
 *  @param  rinfo   The remote address/port information;
 *
 *  This routine will emit any 'response' events.
 *
 *  @return The DNS resonse message.
 */
function _processResponse(self, request, data, rinfo)
{
    /*
    console.log("message:\n%s",
                Utils.buf2hex(msg, {octetsPer:16, ascii:true}));
    // */

    var response    = Mdns.Message(data);

    if (response.header.rcode !== Mdns.consts.RCODE_STR.NOERROR)
    {
        // DNS error
        self.emit('error', new Error('DNS error: '
                                     + Mdns.consts.rcode2str(
                                         response.header.rcode )) );
        self.end( request );
        return response;
    }

    /* :TODO: If there were multiple requests, match this response with a
     *        particular request via id and mark that request as completed.
     */
    if ( self._request &&
            ((response.header.qr !== 1) ||
             (response.header.id !== self._request.header.id)) )
    {
        /*
        console.log("*** Ignore Message:\n%s", response);
        // */

        // Ignore this message
        return response;
    }

    var records = self._records;

    if (request.isMdns)
    {
        records = [];
    }

    response.answer.forEach(function(rec) {
        var pruned  = _prune(rec.rdata);
        pruned.type = Mdns.consts.type2str( rec.type );

        records.push( pruned );
    });
    response.authority.forEach(function(rec) {
        var pruned  = _prune(rec.rdata);
        pruned.type = Mdns.consts.type2str( rec.type );

        records.push( pruned );
    });
    response.additional.forEach(function(rec) {
        var pruned  = _prune(rec.rdata);
        pruned.type = Mdns.consts.type2str( rec.type );

        records.push( pruned );
    });

    if (request.isMdns)
    {
        self.emit('response', records, rinfo, response, data);
    }
    else
    {
        self._rinfos.push( rinfo );
        self._responses.push( response );
        self._data.push( data );
    }

    return response;
}

/** @brief  Generate a shallow clone of the given object, excluding 'consumed'.
 *  @param  src     The object to clone;
 *
 *  @return A new, cloned/pruned object.
 */
function _prune(src)
{
    var dst = {};

    for (key in src)
    {
        if ((! src.hasOwnProperty(key)) || (key === 'consumed'))
        {
            continue;
        }

        dst[key] = src[key];
    }

    return dst;
}
