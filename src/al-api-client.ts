/**
 * Module to deal with discovering available endpoints
 */
import axios, { AxiosInstance, AxiosResponse, AxiosRequestConfig, AxiosError } from 'axios';
import cache from 'cache';
import * as qs from 'qs';
import * as base64JS from 'base64-js';
import { AIMSSessionDescriptor, AIMSAccount } from './types/aims-stub.types';
import { AlLocatorService, AlLocation, AlLocationDescriptor, AlLocationContext } from '@al/common/locator';
import { AlStopwatch, AlTriggerStream } from '@al/common';
import { AlRequestDescriptor } from './utility';
import { AlClientBeforeRequestEvent } from './events';

interface AlApiTarget {
  host: string;
  path: string;
}

/**
 * Describes a single request to be issued against an API.
 * Please notice that it extends the underlying AxiosRequestConfig interface,
 * whose properties are detailed in node_modules/axios/index.d.ts or at https://www.npmjs.com/package/axios#request-config.
 */
export interface APIRequestParams extends AxiosRequestConfig {
  /**
   * The following parameters are used to resolve the correct service location and request path.
   * The presence of `service_name` on a request triggers this process.
   */
  service_name?: string;            //  Which service are we trying to talk to?
  residency?: string;               //  What residency domain do we prefer?  Defaults to 'default'
  version?: string|number;          //  What version of the service do we want to talk to?
  account_id?: string;              //  Which account_id's data are we trying to access/modify through the service?
  path?: string;                    //  What is the path of the specific command within the resolved service that we are trying to interact with?

  /**
   * Should data fetched from this endpoint be cached?  0 ignores caching, non-zero values are treated as milliseconds to persist retrieved data in local memory.
   */
  ttl?: number;

  /**
   * If automatic retry functionality is desired, specify the maximum number of retries and interval multiplier here.
   */
  retry_count?: number;             //  Maximum number of retries
  retry_interval?: number;          //  Delay between any two retries = attemptIndex * retryInterval, defaults to 1000ms

  /**
   * @deprecated If provided, populates Headers.Accept
   */
  accept_header?: string;

  /**
   * @deprecated If provided, is simply copied to axios' `responseType` property
   */
  response_type?: string;
}

export class AlApiClient
{
  public events:AlTriggerStream = new AlTriggerStream();
  public verbose:boolean = false;
  public defaultAccountId:string = null;        //  If specified, uses *this* account ID to resolve endpoints if no other account ID is explicitly specified

  /**
   * Service specific fallback params
   * ttl is 1 minute by default, consumers can set cache duration in requests
   */
  private defaultServiceParams: APIRequestParams = {
    residency:          'default',              //  "us" or "emea" or "default"
    version:            'v1',                   //  Version of the service
    ttl:                60000
  };

  private cache = new cache(60000);
  private instance:AxiosInstance = null;

  constructor() {}

  /**
   * GET - Return Cache, or Call for updated data
   */
  public async get(config: APIRequestParams) {
    let normalized = await this.normalizeRequest( config );
    const queryParams = qs.stringify(config.params);
    let fullUrl = normalized.url;
    if (queryParams.length > 0) {
      fullUrl = `${fullUrl}?${queryParams}`;
    }
    const cacheTTL = typeof( normalized.ttl ) === 'number' && normalized.ttl > 0 ? normalized.ttl : 0;
    if ( cacheTTL ) {
      let cachedValue = this.getCachedValue( fullUrl );
      if ( cachedValue ) {
        this.log(`APIClient::XHR GET ${fullUrl} (FROM CACHE)` );
        return cachedValue;
      }
    }
    this.log(`APIClient::XHR GET ${fullUrl}` );
    const response = await this.axiosRequest( normalized );
    if ( cacheTTL ) {
      this.log(`APIClient::cache(${fullUrl} for ${cacheTTL}ms`);
      this.setCachedValue( fullUrl, response.data, cacheTTL );
    }
    return response.data;
  }

  /**
   * Alias for GET utility method
   */
  public async fetch(config: APIRequestParams) {
    return this.get( config );
  }

  /**
   * POST - clears cache and posts for new/merged data
   */
  public async post(config: APIRequestParams) {
    config.method = 'POST';
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    this.log(`APIClient::XHR POST ${normalized.url}` );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * Form data submission
   */
  public async form(config: APIRequestParams) {
    config.method = 'POST';
    config.headers = {
        'Content-Type': 'multipart/form-data'
    };
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * PUT - replaces data
   */
  public async put(config: APIRequestParams) {
    config.method = 'PUT';
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    this.log(`APIClient::XHR PUT ${normalized.url}` );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * Alias for PUT utility method
   */
  public async set( config:APIRequestParams ) {
    return this.put( config );
  }

  /**
   * Delete data
   */
  public async delete(config: APIRequestParams) {
    config.method = 'DELETE';
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    this.log(`APIClient::XHR DELETE ${normalized.url}` );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * Create a request descriptor interface
   */
  public request<ResponseType>( method:string ):AlRequestDescriptor<ResponseType> {
    const descriptor = new AlRequestDescriptor<ResponseType>( this.executeRequest, method );
    return descriptor;
  }

  public async executeRequest<ResponseType>( options:APIRequestParams ):Promise<AxiosResponse<ResponseType>> {
    return this.axiosRequest( options );
  }

  /**
   * @deprecated
   *
   * Provides a concise way to manipulate the AlLocatorService without importing it directly...
   *
   * @param {array} locations An array of locator descriptors.
   * @param {string|boolean} actingUri The URI to use to calculate the current location and location context; defaults to window.location.origin.
   * @param {AlLocationContext} The effective location context.  See @al/common/locator for more information.
   */
  /* istanbul ignore next */
  public setLocations( locations:AlLocationDescriptor[], actingUri:string|boolean = true, context:AlLocationContext = null ) {
      throw new Error("Please use AlLocatorService.setLocations to update location metadata." );
  }

  /**
   * @deprecated
   *
   * Provides a concise way to set location context without importing AlLocatorService directly.
   *
   * @param {string} environment Should be 'production', 'integration', or 'development'
   * @param {string} residency Should be 'US' or 'EMEA'
   * @param {string} locationId If provided, should be one of the locations service location codes, e.g., defender-us-denver
   * @param {string} accessibleLocations If provided, should be a list of accessible locations service location codes.
   */
  /* istanbul ignore next */
  public setLocationContext( environment:string, residency?:string, locationId?:string, accessibleLocations?:string[] ) {
      throw new Error("Please use AlLocatorService.setContext to override location context." );
  }

  /**
   * @deprecated
   */
  /* istanbul ignore next */
  public resolveLocation( locTypeId:string, path:string = null, context:AlLocationContext = null ) {
    console.warn("Deprecation notice: please use AlLocatorService.resolveURL to calculate resource locations." );
    return AlLocatorService.resolveURL( locTypeId, path, context );
  }

  /**
   * Use HTTP Basic Auth
   * Optionally supply an mfa code if the user account is enrolled for Multi-Factor Authentication
   *
   * Under ordinary circumstances, you should *not* be calling this directly -- instead, you should use the top-level
   * `authenticate` method on @al/session's ALSession instance.
   */
  async authenticate( user: string, pass: string, mfa?:string, ignoreWarning?:boolean ):Promise<AIMSSessionDescriptor> {
    if ( ! ignoreWarning ) {
      console.warn("Warning: this low level authentication method is intended only for use by other services, and will not create a reusable session.  Are you sure you intended to use it?" );
    }
    let payload = {};
    if (mfa) {
      payload = { mfa_code: mfa };
    }
    return this.post( {
      service_name: 'aims',
      path: 'authenticate',
      headers: {
        Authorization: `Basic ${this.base64Encode(`${user}:${pass}`)}`
      },
      data: payload
    });
  }

  /**
   * Authenticate with an mfa code and a temporary session token.
   * Used when a user inputs correct username:password but does not include mfa code when they are enrolled for Multi-Factor Authentication
   * The session token can be used to complete authentication without re-entering the username and password, but must be used within 3 minutes (token expires)
   *
   * Under ordinary circumstances, you should *not* be calling this directly -- instead, you should use the top-level
   * `authenticateWithMFASessionToken` method on @al/session's ALSession instance.
   */
  /* tslint:disable:variable-name */
  async authenticateWithMFASessionToken(token: string, mfa_code: string, ignoreWarning?:boolean):Promise<AIMSSessionDescriptor> {
    if ( ! ignoreWarning ) {
      console.warn("Warning: this low level authentication method is intended only for use by other services, and will not create a reusable session.  Are you sure you intended to use it?" );
    }
    return this.post( {
      service_name: 'aims',
      path: 'authenticate',
      headers: {
        'X-AIMS-Session-Token': token
      },
      data: {
        mfa_code: mfa_code
      }
    } );
  }

  /**
   * Converts a string input to its base64 encoded equivalent.  Uses browser-provided btoa if available, or 3rd party btoa module as a fallback.
   */
  public base64Encode( data:string ):string {
    if ( this.isBrowserBased() && window.btoa ) {
        return btoa( data );
    }
    let utf8Data = unescape( encodeURIComponent( data ) );        //  forces conversion to utf8 from utf16, because...  not sure why
    let bytes = [];
    for ( let i = 0; i < utf8Data.length; i++ ) {
      bytes.push( utf8Data.charCodeAt( i ) );
    }
    let result = base64JS.fromByteArray( bytes );
    return result;
  }

  /**
   * Create a default Discovery Response for Global Stack
   */
  public getDefaultEndpoint() {
    let globalServiceURL = AlLocatorService.resolveURL( AlLocation.GlobalAPI );
    if ( ! globalServiceURL ) {
      return { global: 'https://api.global.alertlogic.com' };
    }
    return { global: globalServiceURL.substring( 8 ) };     //    trim protocol, which will *always* be `https://`
  }

  /**
   * Get endpoint
   * GET
   * /endpoints/v1/:account_id/residency/:residency/services/:service_name/endpoint/:endpoint_type
   * https://api.global-services.global.alertlogic.com/endpoints/v1/:accountId/residency/:residency/services/:serviceName/endpoint/ui
   *
   * Node that 'endpoint_type' here is only useful with value 'api', and this value has been hardcoded into paths for the time being.
   */
  public async getEndpoint(params: APIRequestParams): Promise<AxiosResponse<any>> {
    const defaultEndpoint = this.getDefaultEndpoint();
    let resolveAccountId = '0';
    if ( params.hasOwnProperty( 'account_id' ) ) {
      resolveAccountId = params.account_id;
    } else if ( this.defaultAccountId ) {
      resolveAccountId = this.defaultAccountId;
    }
    let accountId = params.hasOwnProperty( 'account_id' ) ? params.account_id : '0';
    const uri = `https://${defaultEndpoint.global}/endpoints/v1/${resolveAccountId}/residency/default/services/${params.service_name}/endpoint/api`;

    const cachedValue = this.cache.get(uri);
    if ( cachedValue ) {
      return cachedValue;
    }

    this.log(`APIClient:Endpoints: retrieving ${params.service_name}/api from origin`);
    return await this.axiosRequest( { url: uri, retry_count: 3, retry_interval: 1000 } )
                                        .then(  response => {
                                                  this.log(`APIClient:Endpoints: ${params.service_name}/api is `, response.data );
                                                  this.cache.put( uri, response, 15 * 60000 );          //  cache endpoints responses, which change infrequently, for 15 minutes
                                                  return response;
                                                } );
  }

  public async calculateEndpointURI( params: APIRequestParams ):Promise<AlApiTarget> {
    const defaultEndpoint = this.getDefaultEndpoint();
    let fullPath = '';
    if ( ! params.service_name ) {
      throw new Error("Usage error: calculateEndpointURI requires a service_name to work properly." );
    }
    fullPath += `/${params.service_name}`;
    if ( params.version ) {
      if ( typeof( params.version ) === 'string' && params.version.length > 0 ) {
        fullPath += `/${params.version}`;
      } else if ( typeof( params.version ) === 'number' && params.version > 0 ) {
        fullPath += `/v${params.version.toString()}`;
      }
    }
    if (params.account_id && params.account_id !== '0') {
      fullPath += `/${params.account_id}`;
    }
    if (params.hasOwnProperty('path') && params.path.length > 0 ) {
      fullPath += ( params.path[0] === '/' ? '' : '/' )  + params.path;
    }
    return this.getEndpoint(params)
      .then(serviceURI => ({ host: serviceURI.data[params.service_name], path: fullPath }))
      .catch(() => ({ host: defaultEndpoint.global, path: fullPath }));
  }

  public async normalizeRequest(config: APIRequestParams):Promise<APIRequestParams> {
    if ( config.hasOwnProperty("service_name" ) ) {
      // If we are using endpoints resolution to determine our calculated URL, merge defaultServiceParams into our configuration
      config = Object.assign( {}, this.defaultServiceParams, config );       //  clever
      let target = await this.calculateEndpointURI( config );
      config.url = `https://${target.host}${target.path}`;
    }
    if (config.accept_header) {
      if ( ! config.headers ) {
        config.headers = {};
      }
      config.headers.Accept = config.accept_header;
      delete config.accept_header;
    }
    if (config.response_type) {
      config.responseType = config.response_type;
      delete config.response_type;
    }

    return config;
  }

  /**
   * Instantiate a properly configured axios client for services
   */
  getAxiosInstance(): AxiosInstance {
    if ( this.instance ) {
      return this.instance;
    }

    let headers = {
      'Accept': 'application/json, text/plain, */*'
    };

    this.instance = axios.create({
      baseURL: this.getDefaultEndpoint().global,
      timeout: 5000,
      withCredentials: false,
      headers: headers
    });

    this.instance.interceptors.request.use(
      config => {
        this.events.trigger( new AlClientBeforeRequestEvent( config ) );        //    Allow event subscribers to modify the request (e.g., add a session token header) if they want
        return config;
      }
    );
    this.instance.interceptors.response.use(  response => response,
                                              error => Promise.reject( error.response ));
    return this.instance;
  }

  /**
   * Inner request method.  If automatic retry is enabled via the retry_count property of the request config, this method
   * will catch errors of status code 0/3XX/5XX and retry them at staggered intervals (by default, a factorial delay based on number of retries).
   * If any of these requests succeed, the outer promise will be satisfied using the successful result.
   */
  async axiosRequest( config:APIRequestParams, attemptIndex:number = 0 ):Promise<AxiosResponse> {
    const ax = this.getAxiosInstance();
    return ax( config ).then( response => {
                                if ( attemptIndex > 0 ) {
                                  console.warn(`Notice: resolved request for ${config.url} with retry logic.` );
                                }
                                return response;
                              },
                              error => {
                                if ( this.isRetryableError( error, config, attemptIndex ) ) {
                                  attemptIndex++;
                                  const delay = Math.floor( ( config.retry_interval ? config.retry_interval : 1000 ) * attemptIndex );
                                  return new Promise<AxiosResponse>( ( resolve, reject ) => {
                                    AlStopwatch.once(   () => {
                                                          config.params = config.params || {};
                                                          config.params.breaker = this.generateCacheBuster( attemptIndex );
                                                          this.axiosRequest( config, attemptIndex + 1 ).then( resolve, reject );
                                                        },
                                                        delay );
                                  } );
                                }
                                return Promise.reject( error );
                              } );
  }

  /**
   * Utility method to determine whether a given response is a retryable error.
   */
  isRetryableError( error:AxiosResponse, config:APIRequestParams, attemptIndex:number ) {
    if ( ! config.hasOwnProperty("retry_count" ) || attemptIndex >= config.retry_count ) {
      return false;
    }
    if ( ! error ) {
      console.warn( `Notice: will retry request for ${config.url} (null response condition)` );
      return true;
    }
    if ( error.status === 0
          || ( error.status >= 300 && error.status <= 399 )
          || ( error.status >= 500 && error.status <= 599 ) ) {
      console.warn( `Notice: will retry request for ${config.url} (${error.status} response code)` );
      return true;
    }
    return false;
  }

  /**
   * Generates a random cache-busting parameter
   */
  generateCacheBuster( attemptIndex:number ) {
    const verbs = ['debork', 'breaker', 'breaker-breaker', 'fix', 'unbork', 'corex', 'help'];
    const verb = verbs[Math.floor( Math.random() * verbs.length )];
    const hash = ( Date.now() % 60000 ).toString() + Math.floor( Math.random() * 100000 ).toString();
    return `${verb}-${hash}-${attemptIndex.toString()}`;
  }

  /**
   *
   */
  private getCachedValue( key:string):any {
    return this.cache.get( key );
  }

  private setCachedValue( key:string, data:any, ttl:number ):void {
    this.cache.put( key, data, ttl );
  }

  private deleteCachedValue( key:string ):void {
    this.cache.del( key );
  }

  /**
   * Are we running in a browser?
   */
  private isBrowserBased() {
    if (typeof window === 'undefined') {
      return false;
    }
    return true;
  }

  private log( text:string, ...otherArgs:any[] ) {
      if ( this.verbose ) {
          console.log.apply( console, arguments );
      }
  }
}

/* tslint:disable:variable-name */
export const AlDefaultClient = new AlApiClient();
